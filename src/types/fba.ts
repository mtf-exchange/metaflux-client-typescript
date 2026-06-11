// MTF-native FBA (Frequent Batch Auction) action payload type.
//
// Forward-compat: the node recognizes the `fba_submit` action tag but currently
// lowers it to `UnsupportedAction` on the public `/exchange` path. The SDK emits
// the byte-correct shape the core `FbaSubmitParams` decoder expects, so it goes
// live the moment the node bridges the handler — no SDK change required.

import type { CoreSide } from './rfq.js';

/// `fba_submit` — submit an order into a market's frequent-batch-auction pool.
/// Mirrors the node's `core_state` `FbaSubmitParams`. The action envelope wraps
/// this under the key **`submit`**.
///
/// Traps mirrored from the node: `side` is PascalCase (`CoreSide`), the price
/// field is named **`price`** (NOT `limit_px` as in spot/perp orders), and
/// `stp_group` carries no serde default so the key must be present (`null` when
/// absent).
export interface FbaSubmit {
  /// Target market (`u32`).
  market: number;
  /// Side — serializes PascalCase (`"Bid"`/`"Ask"`).
  side: CoreSide;
  /// Submitted size (`u128`, `>= pool.min_lot`). `bigint` — emitted as a bare
  /// JSON number.
  size: bigint;
  /// Limit / worst-acceptable price (`i128`, `> 0`). Field is **`price`** per
  /// the core struct — NOT `limit_px`. `bigint` — emitted as a bare number.
  price: bigint;
  /// Optional STP group (`u64`). The key is ALWAYS present: `null` when absent
  /// (do NOT omit).
  stp_group: number | null;
}
