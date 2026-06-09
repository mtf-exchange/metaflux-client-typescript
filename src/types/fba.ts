// MTF-native frequent-batch-auction action types (mirror the Rust client
// `rest/exchange.rs`). Field ORDER is load-bearing for the signed bytes.

import type { NativeSide } from './trading.js';

/// MTF-native `fba_submit` action payload.
///
/// `{"type":"fba_submit","submit":{owner, market, side, size, limit_px, batch_id}}`.
/// OWNER-CHECKED: `owner` must equal the signing wallet. Submits a frequent-
/// batch-auction order into a given batch.
export interface FbaSubmit {
  /// `0x`-hex 20-byte owner. MUST equal the signing wallet.
  owner: string;
  /// Target market id (`u32`).
  market: number;
  /// Side: `"bid"` (buy) or `"ask"` (sell).
  side: NativeSide;
  /// Order size (`u64`).
  size: number;
  /// Limit price (`u64`).
  limit_px: number;
  /// Target batch id (`u64`).
  batch_id: number;
}
