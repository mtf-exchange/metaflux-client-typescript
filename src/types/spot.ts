// MTF-native spot CLOB (SE-0) action types.
//
// Byte-for-byte mirrors of the server spot action structs. Field ORDER is
// load-bearing for the signed bytes (see `buildNativeSpotOrderAction` /
// `buildNativeSpotCancelAction`).

import type { NativeSide, NativeStpMode, NativeTif } from './trading.js';

/// MTF-native `spot_order` action shape (SE-0 spot CLOB) — byte-for-byte mirror
/// of the server `NativeSpotOrder`. Sender-authorized (the signer is the trader,
/// no `owner`); spot has no positions, so there is no `reduce_only` /
/// `position_side`. v0 accepts ONLY `tif:"ioc"` with `limit_px > 0` — Gtc / Alo
/// and a zero (market) price are rejected by the node.
///
/// Field ORDER is load-bearing for the signed bytes (see `buildNativeSpotOrderAction`).
export interface NativeSpotOrder {
  /// Spot pair id (`u32`); maps identity → asset id.
  pair: number;
  /// Side: `"bid"` (buy) or `"ask"` (sell).
  side: NativeSide;
  /// Base-asset size in raw lots (`u64` on the wire).
  size: number;
  /// Limit price in the 1e8 plane (`u64` on the wire); must be `> 0` in v0.
  limit_px: number;
  /// Time-in-force. v0 requires `"ioc"` (defaulted by the builder).
  tif: NativeTif;
  /// Self-trade-prevention mode.
  stp_mode: NativeStpMode;
  /// Optional `0x`-hex 32-char (16-byte) client order id. Omitted from the
  /// signed bytes entirely when absent.
  cloid?: string;
}

/// MTF-native `spot_cancel` action shape — byte-for-byte mirror of the server
/// `NativeSpotCancel`. Cancels a resting spot order by `oid` (the node cancels
/// by `oid`; there is no cancel-by-cloid on this path).
export interface NativeSpotCancel {
  /// Spot pair id (`u32`).
  pair: number;
  /// Server order id (`u64`) to cancel. REQUIRED.
  oid: number;
}
