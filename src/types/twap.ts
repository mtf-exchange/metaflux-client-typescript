// MTF-native TWAP (time-weighted average price) action payload types.
//
// A TWAP parent slices `total_size` into `slice_count` child orders spaced
// `delay_ms` apart. Sender-authorized (no `owner` field); `total_size` is in
// fixed-point tick units like a perp order's `size`.

import type { NativeSide } from './trading.js';

/// `twap_order` — submit a sliced (TWAP) order.
export interface TwapOrder {
  /// Target market id (`u32`).
  market: number;
  /// Side: `"bid"` (buy) or `"ask"` (sell).
  side: NativeSide;
  /// Total size in fixed-point tick units (`u64`), split across all slices.
  total_size: number;
  /// Number of child slices (`u32`).
  slice_count: number;
  /// Inter-slice delay in milliseconds (`u64`).
  delay_ms: number;
  /// Reduce-only flag (each slice may only reduce an existing position).
  reduce_only: boolean;
}

/// `twap_cancel` — cancel a running TWAP parent by id.
export interface TwapCancel {
  /// TWAP parent id (`u64`), assigned when the parent was submitted.
  twap_id: number;
}
