// Multi-sig inner-signature signing — the roster member's prehash for an
// M-of-N acting bundle.
//
// A multisig account acts by collecting `threshold` distinct roster signatures
// over ONE canonical inner action, then any account POSTs the wrapper
// `{"type":"multi_sig","params":{user, inner_action_blob, signatures, nonce}}`.
// The wrapper's authority is the recovered inner-signer set, NOT the POSTing
// account — so the inner signatures are what this module produces.
//
// TWO inner-digest schemes exist; exactly one is admitted by the chain at a
// time (there is no dual-accept window):
//
//   - USER-BOUND (`MetaFluxMultiSigInner(address user,string action,uint64 nonce)`)
//     binds the acting account into the signed struct. This is the scheme in
//     force once the scheduled network upgrade activates. A roster signature now
//     authorizes exactly ONE account, so two accounts sharing a signer set can
//     no longer replay each other's bundles. THIS IS THE DEFAULT.
//
//   - LEGACY (`MetaFluxAction(string action,uint64 nonce)`) is the pre-upgrade,
//     unbound scheme. Kept as an explicit opt-in for signing BEFORE the upgrade
//     activates; rejected by the chain from the activation point onward.
//
// Byte-exact twin of the chain verifier (`core-state` `signing.rs`
// `multi_sig_inner_digest` / the legacy `native_action_digest`). The signature
// is verified over the EXACT `inner_action_blob` bytes the roster member signed
// — the same bytes later carried (0x-hex) in the wrapper's `inner_action_blob`
// field. Never re-serialize the blob between signing and sending.

import {
  be32,
  concat32,
  domainSeparator,
  hexToBytes,
  toHex,
  validateAddress,
  MTF_CHAIN_ID,
} from './digest.js';
import {
  deriveAddressFromPubkey,
  keccak256,
  recoverPubkey,
  signSecp256k1,
} from '../wallet/wasm.js';

const enc = new TextEncoder();

/// User-bound inner type string (copied verbatim from the chain literal). The
/// `user` field is the ACTING multisig account, not a roster member.
export const MULTI_SIG_INNER_TYPE =
  'MetaFluxMultiSigInner(address user,string action,uint64 nonce)';

/// Legacy (pre-upgrade) inner type string — the same opaque envelope used for a
/// single-signer native action, hashed over the raw inner blob bytes.
export const MULTI_SIG_INNER_LEGACY_TYPE =
  'MetaFluxAction(string action,uint64 nonce)';

/// Which inner-digest scheme a roster member signs under.
///   - `'user-bound'` (default) — the account-bound scheme in force after the
///     scheduled network upgrade.
///   - `'legacy'` — the pre-upgrade unbound scheme; only valid until the upgrade
///     activates, after which the chain rejects it.
export type MultiSigInnerScheme = 'user-bound' | 'legacy';

/// A 20-byte address left-padded into a 32-byte EIP-712 `address` word.
function addrWord(addr: string): Uint8Array {
  validateAddress(addr, 'user');
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex), 12);
  return out;
}

function normalizeBlob(blob: Uint8Array): Uint8Array {
  if (!(blob instanceof Uint8Array)) {
    throw new RangeError('innerActionBlob must be the raw canonical action bytes (Uint8Array)');
  }
  return blob;
}

function checkNonce(nonce: bigint): void {
  if (nonce < 0n) throw new RangeError('nonce must be non-negative');
  if (nonce >= 1n << 64n) throw new RangeError('nonce overflows u64');
}

/// User-bound inner EIP-712 digest a roster member signs (AT/after the upgrade).
///
/// `structHash = keccak256(typeHash || pad32(user) || keccak256(blob) || be32(nonce))`,
/// `digest = keccak256(0x19 0x01 || domainSeparator(chainId) || structHash)`.
///
/// `user` is the acting multisig account; `innerActionBlob` is the EXACT
/// canonical inner-action bytes (never re-serialized); `nonce` is the wrapper
/// nonce (advanced against `user`'s nonce window).
///
/// NOTE on `chainId`: the chain verifies the inner digest under its EVM chain id
/// (`meta_evm.chain_id`), which today equals the signing chain id (114514 /
/// 8964) on every network. The SDK sources both from `MTF_CHAIN_ID`; were they
/// ever to diverge on-chain, this constant would need the EVM id instead.
export async function multiSigInnerDigest(
  user: string,
  innerActionBlob: Uint8Array,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
): Promise<Uint8Array> {
  checkNonce(nonce);
  const blob = normalizeBlob(innerActionBlob);
  const typeHash = await keccak256(enc.encode(MULTI_SIG_INNER_TYPE));
  const userPadded = addrWord(user);
  const actionHash = await keccak256(blob);
  const nonceBe = be32(nonce);
  const structHash = await keccak256(
    concat32(typeHash, userPadded, actionHash, nonceBe),
  );
  return envelope(await domainSeparator(chainId), structHash);
}

/// Legacy (pre-upgrade) inner EIP-712 digest a roster member signs.
///
/// `structHash = keccak256(typeHash || keccak256(blob) || be32(nonce))` over the
/// `MetaFluxAction(string action,uint64 nonce)` type — no user binding. Hashes
/// the RAW blob bytes (NOT a re-serialization). Valid only until the network
/// upgrade activates.
export async function multiSigInnerDigestLegacy(
  innerActionBlob: Uint8Array,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
): Promise<Uint8Array> {
  checkNonce(nonce);
  const blob = normalizeBlob(innerActionBlob);
  const typeHash = await keccak256(enc.encode(MULTI_SIG_INNER_LEGACY_TYPE));
  const actionHash = await keccak256(blob);
  const nonceBe = be32(nonce);
  const structHash = await keccak256(concat32(typeHash, actionHash, nonceBe));
  return envelope(await domainSeparator(chainId), structHash);
}

/// EIP-712 envelope: `keccak256(0x19 0x01 || domainSeparator || structHash)`.
function envelope(domainSep: Uint8Array, structHash: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(2 + 32 + 32);
  buf[0] = 0x19;
  buf[1] = 0x01;
  buf.set(domainSep, 2);
  buf.set(structHash, 34);
  return keccak256(buf);
}

/// Sign one roster member's inner signature over a canonical inner action blob.
///
/// Returns the 65-byte `r||s||v` signature as `0x`-hex — one element of the
/// wrapper's `signatures` array. Default scheme is `'user-bound'`; pass
/// `{ scheme: 'legacy' }` only to sign for the pre-upgrade unbound scheme.
export async function signMultiSigInner(
  privateKey: Uint8Array,
  user: string,
  innerActionBlob: Uint8Array,
  nonce: bigint,
  opts: { scheme?: MultiSigInnerScheme; chainId?: number } = {},
): Promise<string> {
  if (privateKey.length !== 32) {
    throw new RangeError('privateKey must be exactly 32 bytes');
  }
  const scheme: MultiSigInnerScheme = opts.scheme ?? 'user-bound';
  const chainId = opts.chainId ?? MTF_CHAIN_ID;
  const digest =
    scheme === 'legacy'
      ? await multiSigInnerDigestLegacy(innerActionBlob, nonce, chainId)
      : await multiSigInnerDigest(user, innerActionBlob, nonce, chainId);
  const sig = await signSecp256k1(privateKey, digest);
  return `0x${toHex(sig)}`;
}

/// Recover the 20-byte roster signer of one inner signature — used to assert
/// membership locally before packaging a wrapper. Mirrors the scheme selection
/// of [`signMultiSigInner`].
export async function recoverMultiSigInner(
  signature: string,
  user: string,
  innerActionBlob: Uint8Array,
  nonce: bigint,
  opts: { scheme?: MultiSigInnerScheme; chainId?: number } = {},
): Promise<string> {
  const scheme: MultiSigInnerScheme = opts.scheme ?? 'user-bound';
  const chainId = opts.chainId ?? MTF_CHAIN_ID;
  const digest =
    scheme === 'legacy'
      ? await multiSigInnerDigestLegacy(innerActionBlob, nonce, chainId)
      : await multiSigInnerDigest(user, innerActionBlob, nonce, chainId);
  const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
  const pubkey = await recoverPubkey(hexToBytes(sigHex), digest);
  const addr = await deriveAddressFromPubkey(pubkey);
  return `0x${toHex(addr)}`;
}
