// MTF-native signed-action digest + envelope construction (signing core).
//
// This is the byte-exact TS twin of the Rust SDK reference
// (`metaflux-client-rust/src/rest/exchange.rs::ActionSignedDigest`) and the
// server's native-action signature verifier.
//
// digest = keccak256(0x1901 || domainSep5 || structHash)
//   domainSep5 = keccak256(
//       keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
//       || keccak256("MetaFlux") || keccak256("1")
//       || chainId_be32 || verifyingContract_padded32 )   // verifyingContract = 0x0
//   structHash = keccak256(
//       keccak256("MetaFluxAction(string action,uint64 nonce)")
//       || keccak256(action_json_bytes) || nonce_be32 )
//
// CRITICAL: the signature is verified over the EXACT `action` bytes the server
// receives (it parses `action` as `serde_json::value::RawValue`). So the same
// JSON string MUST be both signed and sent verbatim — never re-stringified
// from a parsed object. The `build*Action` functions in `./actions.js` are the
// single source of those bytes.

import {
  deriveAddressFromPubkey,
  keccak256,
  recoverPubkey,
  signSecp256k1,
} from '../wallet/wasm.js';
import type { NativeSignedAction } from '../types/index.js';

const MTF_DOMAIN_TYPE =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const MTF_ACTION_TYPE = 'MetaFluxAction(string action,uint64 nonce)';

/// MTF EIP-712 domain chain ids. MetaFlux runs its own verified-unregistered
/// chain ids, distinct from Hyperliquid's testnet `998` (retired here to avoid
/// a competitor collision — signing with `998` would land in HL's domain).
/// The chain id rides in the EIP-712 domain separator and the node enforces
/// the same value, so a mismatch makes every `POST /exchange` return 401.
///
/// - mainnet `8964` (0x2304)
/// - testnet `114514` (0x1bf52) — the live devnet/testnet runs this.
export const MTF_MAINNET_CHAIN_ID = 8964;
export const MTF_TESTNET_CHAIN_ID = 114514;

/// Default MTF chain id (matches `MTF_CHAIN_ID` in the Rust SDK + the server
/// KAT vector). Aliases the testnet id, since the live devnet/testnet is what
/// the SDK signs against today.
export const MTF_CHAIN_ID = MTF_TESTNET_CHAIN_ID;

const enc = new TextEncoder();

let nonceClock = 0n;

/// Strictly-increasing replay nonce — at least the current unix-ms, but bumped
/// past the last issued value so a burst of orders within one millisecond gets
/// distinct nonces. The server's per-account window tolerates out-of-order
/// delivery but rejects collisions, so a raw `Date.now()` would drop the
/// 2nd-and-later order in a same-ms burst.
export function nextNonce(): bigint {
  const now = BigInt(Date.now());
  nonceClock = now > nonceClock ? now : nonceClock + 1n;
  return nonceClock;
}

/// Encode a `bigint` as a 32-byte big-endian buffer (uint256 / nonce slot).
/// The value rides in the low bytes; high bytes are zero. Rejects negatives
/// and values that overflow 256 bits.
export function be32(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError('be32: value must be non-negative');
  if (value >= 1n << 256n) throw new RangeError('be32: value overflows uint256');
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/// Concatenate 32-byte chunks into one buffer.
export function concat32(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.length * 32);
  chunks.forEach((c, i) => {
    if (c.length !== 32) {
      throw new RangeError(`concat32: chunk ${i} is ${c.length} bytes, want 32`);
    }
    out.set(c, i * 32);
  });
  return out;
}

/// Compute the 5-field MTF-native EIP-712 domain separator.
export async function domainSeparator(chainId: number): Promise<Uint8Array> {
  const typeHash = await keccak256(enc.encode(MTF_DOMAIN_TYPE));
  const nameHash = await keccak256(enc.encode('MetaFlux'));
  const versionHash = await keccak256(enc.encode('1'));
  const chainIdBe = be32(BigInt(chainId));
  // verifyingContract = 0x0 address, left-padded to 32 bytes => all zeros.
  const verifyingPadded = new Uint8Array(32);
  return keccak256(
    concat32(typeHash, nameHash, versionHash, chainIdBe, verifyingPadded),
  );
}

/// Compute the native action EIP-712 digest over the EXACT `actionJson` bytes.
///
/// Returns the 32-byte digest the wallet signs. `actionJson` MUST be the
/// identical string later POSTed in the `action` field (raw, not re-parsed).
export async function nativeActionDigest(
  actionJson: string,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
): Promise<Uint8Array> {
  if (nonce < 0n) throw new RangeError('nonce must be non-negative');
  if (nonce >= 1n << 64n) throw new RangeError('nonce overflows u64');

  const actionTypeHash = await keccak256(enc.encode(MTF_ACTION_TYPE));
  const actionHash = await keccak256(enc.encode(actionJson));
  const nonceBe = be32(nonce);
  const structHash = await keccak256(
    concat32(actionTypeHash, actionHash, nonceBe),
  );

  const domainSep = await domainSeparator(chainId);

  // EIP-712 envelope: keccak256(0x19 || 0x01 || domainSep || structHash).
  const envelope = new Uint8Array(2 + 32 + 32);
  envelope[0] = 0x19;
  envelope[1] = 0x01;
  envelope.set(domainSep, 2);
  envelope.set(structHash, 34);
  return keccak256(envelope);
}

/// Lowercase hex (no `0x`) of a byte buffer.
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// JSON-escape a string for inclusion in the hand-built action body. We build
/// the action JSON manually (rather than `JSON.stringify`-ing an object) so
/// the byte layout is fully under our control and matches the server's
/// expectation field-for-field. The only string values are `0x`-hex addresses
/// / cloids and fixed enum tokens, none of which contain characters needing
/// escaping — but we escape defensively so a malformed input can never inject
/// raw control bytes into the signed payload.
export function jsonStr(s: string): string {
  return JSON.stringify(s);
}

/// Sign a pre-built action JSON string with the given private key.
///
/// The returned envelope's `actionJson` is the SAME string passed in — the
/// caller must POST it verbatim so the server verifies over identical bytes.
export async function signNativeAction(
  privateKey: Uint8Array,
  actionJson: string,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
): Promise<NativeSignedAction> {
  if (privateKey.length !== 32) {
    throw new RangeError('privateKey must be exactly 32 bytes');
  }
  const digest = await nativeActionDigest(actionJson, nonce, chainId);
  const sig = await signSecp256k1(privateKey, digest);
  return { actionJson, nonce, signature: `0x${toHex(sig)}` };
}

/// Recover the 20-byte signer address from a native signed action — handy for
/// asserting the owner field locally before POSTing.
export async function recoverNativeSigner(
  signed: NativeSignedAction,
  chainId: number = MTF_CHAIN_ID,
): Promise<string> {
  const digest = await nativeActionDigest(
    signed.actionJson,
    signed.nonce,
    chainId,
  );
  const sigHex = signed.signature.startsWith('0x')
    ? signed.signature.slice(2)
    : signed.signature;
  const sig = hexToBytes(sigHex);
  const pubkey = await recoverPubkey(sig, digest);
  const addr = await deriveAddressFromPubkey(pubkey);
  return `0x${toHex(addr)}`;
}

/// Assemble the full `POST /exchange` request body STRING.
///
/// Hand-built so the `action` field carries the exact signed bytes (no
/// re-stringify of a parsed object). The body shape is
/// `{"action":<actionJson>,"nonce":<u64>,"signature":"0x.."}`.
export function nativeRequestBody(signed: NativeSignedAction): string {
  return `{${jsonStr('action')}:${signed.actionJson},${jsonStr('nonce')}:${signed.nonce},${jsonStr('signature')}:${jsonStr(signed.signature)}}`;
}

// ---- validation helpers (fail loud before anything reaches the signed body) ----

export function validateAddress(addr: string, field: string): void {
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  if (hex.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new RangeError(`${field} must be a 0x-prefixed 20-byte hex address`);
  }
}

export function validateCloid(cloid: string): void {
  const hex = cloid.startsWith('0x') ? cloid.slice(2) : cloid;
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new RangeError('cloid must be a 0x-prefixed 16-byte hex string');
  }
}

export function validateMarket(market: number): void {
  if (!Number.isInteger(market) || market < 0 || market > 0xffffffff) {
    throw new RangeError('market must be a u32');
  }
}

export function validateU64(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `${field} exceeds Number.MAX_SAFE_INTEGER; use a value below 2^53`,
    );
  }
}

/// Validate a `u32` field passed as a plain `number` (e.g. dst_chain,
/// window_ms, action-own nonces). Same shape as `validateMarket` but with a
/// caller-supplied field name for the error message.
export function validateU32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${field} must be a u32`);
  }
}

/// Validate a `u16` field passed as a plain `number` (e.g. management_fee_bps).
export function validateU16(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${field} must be a u16 (0..=65535)`);
  }
}

/// Validate a `u8` field passed as a plain `number` (e.g. threshold).
export function validateU8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${field} must be a u8 (0..=255)`);
  }
}

/// Validate a `u128` field passed as a `bigint`, emitted as a bare unquoted
/// integer literal on the wire (serde u128 JSON number form). Rejects negatives
/// and values that overflow 128 bits.
export function validateU128(value: bigint, field: string): void {
  if (typeof value !== 'bigint') {
    throw new RangeError(`${field} must be a bigint`);
  }
  if (value < 0n) throw new RangeError(`${field} must be non-negative`);
  if (value >= 1n << 128n) throw new RangeError(`${field} overflows u128`);
}

/// Validate an `i128` field passed as a `bigint`, emitted as a bare unquoted
/// integer literal on the wire (serde i128 JSON number form). Accepts the full
/// signed-128-bit range `[-2^127, 2^127)`.
export function validateI128(value: bigint, field: string): void {
  if (typeof value !== 'bigint') {
    throw new RangeError(`${field} must be a bigint`);
  }
  if (value < -(1n << 127n) || value >= 1n << 127n) {
    throw new RangeError(`${field} overflows i128`);
  }
}

/// Validate a decimal magnitude passed as a string and emitted as a JSON
/// **string** on the wire (e.g. spot-margin `amount` / `borrow`, Earn
/// `shares`). The server decodes these as a fixed-point `Decimal`, so they must
/// be JSON strings to preserve fractional precision past 2^53. Accepts an
/// optional sign, integer and/or fractional parts; rejects empty / malformed
/// input and (by default) non-positive values.
export function validateDecimalString(
  value: string,
  field: string,
  opts: { allowZero?: boolean; allowNegative?: boolean } = {},
): void {
  if (typeof value !== 'string') {
    throw new RangeError(`${field} must be a decimal string`);
  }
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    throw new RangeError(`${field} must be a decimal string, got '${value}'`);
  }
  const negative = value.startsWith('-');
  if (negative && !opts.allowNegative) {
    throw new RangeError(`${field} must be non-negative`);
  }
  // Reject a pure-zero magnitude (e.g. "0", "0.0", "-0.00") unless allowed.
  const isZero = /^-?0*\.?0*$/.test(value);
  if (isZero && !opts.allowZero) {
    throw new RangeError(`${field} must be greater than zero`);
  }
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new RangeError('hex length must be even');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
