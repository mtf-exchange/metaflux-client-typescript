// WASM module loader + typed facade.
//
// The wasm-pack-emitted `pkg/metaflux_client_wasm.js` is dynamically
// imported so the bundle can be tree-shaken when consumers only want
// the pure-TS REST surface. `loadWasm()` is idempotent; first call
// instantiates, subsequent calls reuse the resolved promise.
//
// Why dynamic import + facade?
//
// 1. The `pkg/` directory is only present after `npm run build:wasm`.
//    A top-level `import` would crash on a fresh clone before that step
//    runs; dynamic import lets the WASM-using code paths fail with a
//    helpful error pointing to the build command.
// 2. The wasm-bindgen-generated module exports raw `Uint8Array` returns
//    that are zero-length on encoder failure (see `lib.rs`). The facade
//    promotes that to a typed exception, keeping the Client surface
//    free of "did this succeed?" branches.

import type { Builder, Side, StpMode, Tif } from './types.js';

/// Shape of the WASM module after `pkg/` is built. Mirrors the
/// `#[wasm_bindgen]` exports in `wasm/src/lib.rs`. Kept narrow — we only
/// document the symbols the TS layer calls.
interface WasmModule {
  default: (path?: string | URL | Request) => Promise<unknown>;
  keccak256: (data: Uint8Array) => Uint8Array;
  sign_secp256k1: (privKey: Uint8Array, messageHash: Uint8Array) => Uint8Array;
  recover_pubkey: (sig: Uint8Array, messageHash: Uint8Array) => Uint8Array;
  verify_secp256k1: (
    pubkeyCompressed: Uint8Array,
    sig: Uint8Array,
    messageHash: Uint8Array,
  ) => boolean;
  eip712_typed_data_hash: (
    domainSeparator: Uint8Array,
    messageHash: Uint8Array,
  ) => Uint8Array;
  encode_limit_order: (
    asset: number,
    side: number,
    sizeE8Lo: bigint,
    sizeE8Hi: bigint,
    priceE8Lo: bigint,
    priceE8Hi: bigint,
    tif: number,
    stp: number,
    hasCloid: boolean,
    cloidLo: bigint,
    cloidHi: bigint,
    reduceOnly: boolean,
    hasBuilder: boolean,
    builderFee: number,
    builderUser: Uint8Array,
  ) => Uint8Array;
  derive_address_from_pubkey: (pubkey: Uint8Array) => Uint8Array;
}

let wasmPromise: Promise<WasmModule> | undefined;

/// Custom error thrown when the WASM module cannot be loaded — e.g. on
/// a fresh clone before `npm run build:wasm` has produced `pkg/`. The
/// message points at the fix.
export class WasmNotBuiltError extends Error {
  constructor(cause?: unknown) {
    super(
      'metaflux_client_wasm not built. Run `npm run build:wasm` first ' +
        '(requires `wasm-pack`; install via `brew install wasm-pack`).',
    );
    this.name = 'WasmNotBuiltError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/// Thrown when a WASM-side encoder/signer returns an empty buffer (the
/// `lib.rs` convention for invalid input). Carries the failed call name.
export class WasmCallError extends Error {
  constructor(public readonly call: string, hint?: string) {
    super(
      `WASM call '${call}' returned empty result` +
        (hint !== undefined ? ` (${hint})` : ''),
    );
    this.name = 'WasmCallError';
  }
}

/// Idempotently load + initialise the WASM module.
///
/// First call dynamically imports `../pkg/metaflux_client_wasm.js`
/// (the wasm-pack output), invokes the default-export `init`, and
/// caches the resolved module. Subsequent calls return the cached
/// promise — both fast-path and re-entrant safe.
///
/// The dynamic import path is built from a string variable so the
/// TypeScript compiler does not try to statically resolve the
/// (until-built) `pkg/` directory at typecheck time. The shape
/// expected from the loaded module is enforced by the cast to
/// `WasmModule`.
export async function loadWasm(): Promise<WasmModule> {
  if (wasmPromise === undefined) {
    wasmPromise = (async () => {
      let mod: WasmModule;
      try {
        // Path is relative to the *compiled* dist/ output (one level
        // above pkg/ at the repo root). At dev-mode (vitest running
        // .ts directly) the same relative path lands on the same
        // pkg/ directory because vitest cwd is the repo root.
        const wasmPath = '../pkg/metaflux_client_wasm.js';
        mod = (await import(/* @vite-ignore */ wasmPath)) as WasmModule;
      } catch (err) {
        throw new WasmNotBuiltError(err);
      }
      // wasm-pack's default-export `init` accepts an optional .wasm source;
      // we let it auto-resolve relative to the .js shim. The Node-target
      // build (`--target nodejs`) loads the .wasm synchronously at
      // module-load time and exposes NO default export — only `web` /
      // `bundler` builds need this call.
      if (typeof (mod as { default?: unknown }).default === 'function') {
        const init = (mod as { default: (arg?: unknown) => Promise<unknown> })
          .default;
        try {
          // Browser / bundler: default-resolve the .wasm via fetch.
          await init();
        } catch (fetchErr) {
          // Node (incl. vitest): the web-target shim's `init()` fetches the
          // .wasm by file URL, which Node's fetch refuses. Fall back to
          // reading + compiling the bytes ourselves and handing them to
          // init(). Only attempt this where `node:fs` is importable; if it
          // is not (true browser), rethrow the original fetch error.
          const compiled = await compileWasmFromFs();
          if (compiled === undefined) throw fetchErr;
          await init({ module_or_path: compiled });
        }
      }
      return mod;
    })();
  }
  return wasmPromise;
}

/// Reset the cached module — used by tests that want to exercise the
/// WasmNotBuiltError path. Not part of the public API.
export function _resetWasmCacheForTest(): void {
  wasmPromise = undefined;
}

/// Node-only: read + compile the wasm-pack `_bg.wasm` bytes so the web-target
/// `init()` can be fed a ready module instead of fetching a file URL (which
/// Node's `fetch` rejects). Returns `undefined` in environments without
/// `node:fs` (a real browser), where the fetch path is correct anyway.
async function compileWasmFromFs(): Promise<WebAssembly.Module | undefined> {
  try {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    // Resolve the .wasm next to the wasm-pack .js shim. From dev (vitest on
    // src/*.ts) the cwd is the repo root and pkg/ sits there; from the
    // compiled dist/ output pkg/ is one level up. Try both.
    const candidates = [
      path.resolve(process.cwd(), 'pkg', 'metaflux_client_wasm_bg.wasm'),
      url.fileURLToPath(
        new URL('../pkg/metaflux_client_wasm_bg.wasm', import.meta.url),
      ),
    ];
    for (const c of candidates) {
      try {
        const bytes = await fs.readFile(c);
        return await WebAssembly.compile(bytes);
      } catch {
        // Try the next candidate.
      }
    }
    return undefined;
  } catch {
    // `node:fs` unavailable -> not Node; the fetch path is the right one.
    return undefined;
  }
}

// ============================================================================
// Typed wrappers — each promotes an empty WASM result to a thrown error.
// ============================================================================

/// `keccak256(data)` -> 32-byte digest. Throws `WasmCallError` on empty
/// result (should not happen — keccak accepts any length input).
export async function keccak256(data: Uint8Array): Promise<Uint8Array> {
  const wasm = await loadWasm();
  const out = wasm.keccak256(data);
  if (out.length !== 32) {
    throw new WasmCallError('keccak256', `got ${out.length} bytes, want 32`);
  }
  return out;
}

/// Produce a recoverable ECDSA signature in `r || s || v` 65-byte form.
/// Throws on a malformed private key or message hash length.
export async function signSecp256k1(
  privKey: Uint8Array,
  messageHash: Uint8Array,
): Promise<Uint8Array> {
  const wasm = await loadWasm();
  const out = wasm.sign_secp256k1(privKey, messageHash);
  if (out.length !== 65) {
    throw new WasmCallError(
      'sign_secp256k1',
      'invalid private key or message hash length (expected 32 bytes each)',
    );
  }
  return out;
}

/// Recover the 33-byte compressed pubkey from a sig + message digest.
export async function recoverPubkey(
  sig: Uint8Array,
  messageHash: Uint8Array,
): Promise<Uint8Array> {
  const wasm = await loadWasm();
  const out = wasm.recover_pubkey(sig, messageHash);
  if (out.length !== 33) {
    throw new WasmCallError(
      'recover_pubkey',
      'malformed signature or message hash',
    );
  }
  return out;
}

/// EIP-712 envelope hash: `keccak256(0x1901 || domain || message)`.
export async function eip712TypedDataHash(
  domainSeparator: Uint8Array,
  messageHash: Uint8Array,
): Promise<Uint8Array> {
  const wasm = await loadWasm();
  const out = wasm.eip712_typed_data_hash(domainSeparator, messageHash);
  if (out.length !== 32) {
    throw new WasmCallError(
      'eip712_typed_data_hash',
      `got ${out.length} bytes, want 32`,
    );
  }
  return out;
}

/// Encode the canonical msgpack body for an `order` action. The 128-bit
/// `priceE8` / `sizeE8` amounts are split into (lo, hi) `bigint` words
/// for the wasm-bindgen ABI — see `lib.rs::u128_from_parts`.
///
/// `stp` (self-trade-prevention) and `reduceOnly` are REQUIRED on the node's
/// signed wire (`OrderParams` has no serde default for either); they default
/// here to `0` (CancelNewest) / `false` so callers can omit them, but are
/// always emitted into the body.
///
/// `cloid` (optional client order id) rides the signed body as the raw 128-bit
/// integer — the node's `Cloid(u128)` wire form — split into (lo, hi) words for
/// the wasm-bindgen ABI. Omit for no cloid (the key is skipped; the node fills
/// `None`).
///
/// `builder` (ADR-012 §L.5.2) is optional. When supplied it is encoded
/// INSIDE the body so the carve is covered by the EIP-712 signature; an
/// omitted builder produces byte-identical output to the pre-builder
/// encoder (the `builder` key is skipped, and the node defaults it to
/// `None`).
export async function encodeLimitOrder(
  asset: number,
  side: Side,
  sizeE8: bigint,
  priceE8: bigint,
  tif: Tif,
  stp: StpMode = 0,
  cloid?: bigint,
  reduceOnly = false,
  builder?: Builder,
): Promise<Uint8Array> {
  if (sizeE8 < 0n) throw new RangeError('sizeE8 must be non-negative');
  if (priceE8 < 0n) throw new RangeError('priceE8 must be non-negative');
  if (sizeE8 >= 1n << 128n)
    throw new RangeError('sizeE8 overflows u128');
  if (priceE8 >= 1n << 128n)
    throw new RangeError('priceE8 overflows u128');
  const mask64 = (1n << 64n) - 1n;
  const sizeLo = sizeE8 & mask64;
  const sizeHi = (sizeE8 >> 64n) & mask64;
  const priceLo = priceE8 & mask64;
  const priceHi = (priceE8 >> 64n) & mask64;

  // Cloid: optional 128-bit client order id. On the signed wire it is the
  // raw u128 (node `Cloid(u128)`), split into (lo, hi) for the ABI.
  let hasCloid = false;
  let cloidLo = 0n;
  let cloidHi = 0n;
  if (cloid !== undefined) {
    if (cloid < 0n) throw new RangeError('cloid must be non-negative');
    if (cloid >= 1n << 128n) throw new RangeError('cloid overflows u128');
    hasCloid = true;
    cloidLo = cloid & mask64;
    cloidHi = (cloid >> 64n) & mask64;
  }

  // Builder carve. Validate fee + address shape on the TS side so a
  // malformed carve fails loudly here rather than encoding silently —
  // an unsigned or dropped builder would be worse than a thrown error.
  let hasBuilder = false;
  let builderFee = 0;
  let builderUser: Uint8Array = EMPTY_BYTES;
  if (builder !== undefined) {
    if (!Number.isInteger(builder.fee) || builder.fee < 0 || builder.fee > 0xffff) {
      throw new RangeError('builder.fee must be a u16 (0..=65535) in basis points');
    }
    builderUser = addressHexToBytes(builder.user);
    hasBuilder = true;
    builderFee = builder.fee;
  }

  const wasm = await loadWasm();
  const out = wasm.encode_limit_order(
    asset,
    side,
    sizeLo,
    sizeHi,
    priceLo,
    priceHi,
    tif,
    stp,
    hasCloid,
    cloidLo,
    cloidHi,
    reduceOnly,
    hasBuilder,
    builderFee,
    builderUser,
  );
  if (out.length === 0) {
    throw new WasmCallError(
      'encode_limit_order',
      'msgpack encoder failed (invalid builder address length?)',
    );
  }
  return out;
}

/// Shared empty buffer for the no-builder fast path — avoids allocating a
/// fresh zero-length `Uint8Array` per call.
const EMPTY_BYTES = new Uint8Array(0);

/// Parse a `0x`-prefixed (or bare) 40-char hex address into 20 raw bytes.
/// Mirrors `core_state::address::Address::from_hex`. Throws on any
/// non-hex char or wrong length — a malformed builder address must never
/// reach the signed body.
function addressHexToBytes(addr: string): Uint8Array {
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  if (hex.length !== 40) {
    throw new RangeError(
      `builder.user must be a 20-byte (40 hex char) address, got '${addr}'`,
    );
  }
  // Whole-string hex check up front — `parseInt('1z', 16)` would silently
  // return 1, so per-byte parsing alone could mask a malformed char.
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new RangeError(`builder.user contains a non-hex character: '${addr}'`);
  }
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/// Derive the standard 20-byte EVM address from a SEC1 public key.
/// Accepts 33-byte compressed, 64-byte raw x||y, or 65-byte
/// uncompressed `0x04 || x || y`.
export async function deriveAddressFromPubkey(
  pubkey: Uint8Array,
): Promise<Uint8Array> {
  const wasm = await loadWasm();
  const out = wasm.derive_address_from_pubkey(pubkey);
  if (out.length !== 20) {
    throw new WasmCallError(
      'derive_address_from_pubkey',
      'malformed pubkey (expected 33, 64, or 65 bytes)',
    );
  }
  return out;
}
