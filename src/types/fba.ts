// MTF-native FBA (Frequent Batch Auction) action payload type.
//
// Rides the W1 typed (the typed `/exchange`) path: the SDK signs the node's
// frozen `FbaSubmit` EIP-712 struct and POSTs the canonical
// `{"type":"fba_submit","params":{...}}` envelope the typed-only `/exchange`
// admits. The typed encoding (`../native/typed`) is the single source of truth.

import type { CoreSide } from './rfq.js';

/// `fba_submit` — submit an order into a market's frequent-batch-auction pool.
/// Mirrors the node's frozen `FbaSubmit` typed struct.
///
/// Traps mirrored from the node: `side` is PascalCase (`CoreSide`); the price
/// field is named **`price`** (NOT `limit_px` as in spot/perp orders). All
/// numeric fields are RAW `u64` wire values, NOT decimal-scaled. `stp_group` is
/// `Option<u64>`: the typed digest flattens it to a presence bool + value, and
/// the POST `params` carries the key ONLY when present (omit, or pass `null`).
export interface FbaSubmit {
  /// Target market (`u32`).
  market: number;
  /// Side — POSTs PascalCase (`"Bid"`/`"Ask"`), signs the uint8 code.
  side: CoreSide;
  /// Submitted size (`u64`, `>= pool.min_lot`).
  size: number | bigint;
  /// Limit / worst-acceptable price (`u64`, `> 0`). Field is **`price`** per the
  /// core struct — NOT `limit_px`.
  price: number | bigint;
  /// Optional STP group (`u64`). Omit or pass `null` when absent.
  stp_group?: number | bigint | null;
}
