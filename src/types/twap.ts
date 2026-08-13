// MTF-native TWAP (time-weighted average price) action payload types.
//
// A TWAP parent slices `total_size` into `slice_count` child orders spaced
// `delay_ms` apart. Sender-authorized (no `owner` field); `total_size` is in
// fixed-point tick units like a perp order's `size`.
//
// PERP MARKETS ONLY TODAY. A spot pair id in `market` is refused at commit with
// `no perp market for asset`. The spot lane is built and waits for an activation
// height. Above it each slice is an Ioc through the spot order path, priced off
// the base token's oracle mark rather than off the touch, and THREE fields are
// REFUSED rather than dropped — the whole action is rejected:
//
//   reduce_only: true  -> `spot has no position to reduce: reduce_only is not supported`
//   position_side      -> `spot has no position side`
//   randomize: true    -> `spot twap does not support randomize`
//
// A slice with no reference mark PARKS (it does not fire and does not count); a
// slice that fires and crosses nothing ADVANCES the schedule and fills nothing.
// One live-parent budget covers perp and spot parents together, and `twap_cancel`
// takes a spot parent's id unchanged. The wire shape does not change, so these
// types need no new field.

import type { NativePositionSide, NativeSide } from './trading.js';

/// `twap_order` — submit a sliced (TWAP) order.
export interface TwapOrder {
  /// Target market id (`u32`) — a PERP market today. A spot pair id is refused
  /// until the spot lane activates (see the module doc).
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
  /// HEDGE MODE: the leg every child order carries. REQUIRED on a hedge
  /// account and REFUSED on a one-way one. Absent keeps the pre-hedge signing
  /// string, so a one-way payload stays byte-identical to an older SDK.
  position_side?: NativePositionSide;
  /// Randomize the slice schedule: the chain draws each slice size and each
  /// inter-slice delay from a digest over committed inputs, so a TWAP is harder
  /// to front-run. Deterministic — every validator draws the same numbers.
  ///
  /// `true` selects the V3 signing string WHATEVER the leg, so a randomized
  /// one-way parent signs an empty `positionSide`. Absent or `false` keeps the
  /// older strings and the fixed schedule, byte for byte.
  randomize?: boolean;
}

/// `twap_cancel` — cancel a running TWAP parent by id.
export interface TwapCancel {
  /// TWAP parent id (`u64`), assigned when the parent was submitted.
  twap_id: number;
}
