// Public barrel — every export consumers see goes through this file.
//
// Pinning the public surface here means we can refactor the internal
// `client.ts` / `wasm.ts` / `http.ts` split without touching anything
// import-facing. The npm package `exports` map points at the compiled
// `dist/index.js`, so consumers write:
//
//     import { Client, type Order } from '@metaflux/client';

export { Client, type ClientOpts } from './client.js';
export { MetaFluxApiError } from './http.js';
export {
  // MTF-native signed-action surface (the path the server now accepts).
  // Exported so power users can build / sign / inspect actions out-of-band.
  MTF_CHAIN_ID,
  nativeActionDigest,
  buildNativeOrderAction,
  signNativeAction,
  recoverNativeSigner,
  nativeRequestBody,
} from './native.js';
export {
  WasmNotBuiltError,
  WasmCallError,
  // Low-level crypto wrappers — exported so power users can build
  // their own signing flows (e.g. transferring sign() out of the
  // browser to a hardware-backed signer).
  keccak256,
  signSecp256k1,
  recoverPubkey,
  eip712TypedDataHash,
  encodeLimitOrder,
  deriveAddressFromPubkey,
} from './wasm.js';
export type {
  Order,
  Builder,
  SignedOrder,
  OrderAck,
  Market,
  Position,
  Side,
  Tif,
  ErrorEnvelope,
  // MTF-native action types.
  NativeOrder,
  NativeBuilder,
  NativeSide,
  NativeOrderKind,
  NativeTif,
  NativeStpMode,
  NativeSignedAction,
  NativeExchangeAck,
} from './types.js';
