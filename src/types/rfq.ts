// MTF-native request-for-quote action types (mirror the Rust client
// `rest/exchange.rs`). Field ORDER is load-bearing for the signed bytes.

import type { NativeSide } from './trading.js';

/// MTF-native `rfq_request` action payload.
///
/// `{"type":"rfq_request","rfq":{taker, market, side, size, window_ms}}`.
/// OWNER-CHECKED: `taker` must equal the signing wallet.
export interface RfqRequest {
  /// `0x`-hex 20-byte taker. MUST equal the signing wallet.
  taker: string;
  /// Target market id (`u32`).
  market: number;
  /// Side: `"bid"` (buy) or `"ask"` (sell).
  side: NativeSide;
  /// Requested size (`u64`).
  size: number;
  /// Quote window in milliseconds (`u32`).
  window_ms: number;
}

/// MTF-native `rfq_accept` action payload.
///
/// `{"type":"rfq_accept","accept":{rfq_id, mm, price}}`. SENDER-AUTHORIZED — the
/// market maker accepts an outstanding RFQ.
export interface RfqAccept {
  /// Target RFQ id (`u64`).
  rfq_id: number;
  /// `0x`-hex 20-byte market-maker address.
  mm: string;
  /// Quoted price (`u64`).
  price: number;
}
