// Client-side TWAP planning: a duration and a USD notional become the wire
// fields `slice_count`, `delay_ms` and `total_size`.
//
// The wire carries no duration and no USD amount. A caller who thinks in "sell
// this much, over this long" must derive the three wire fields itself, so this
// module does it once, the same way in every MetaFlux client.
//
// THE MINIMUM-DELAY FLOOR IS THE PART CALLERS GET WRONG. The node clamps
// `delay_ms` UP to a governed minimum at registration (`twap_min_delay_ms`,
// default 10_000 ms). The clamp is silent: the order is accepted, and the parent
// then runs LONGER than the duration the caller typed. The floor is served on no
// endpoint, so it arrives here as a parameter. [`twapFromDuration`] reports the
// clamp in `clampedToMinDelay` and reports the run time the chain will actually
// take in `effectiveDurationMs`. Show the caller that number, not the request.
//
// No floating point in the USD -> size conversion: the USD amount and the mark
// are parsed straight into scaled integers and divided toward zero, so a large
// notional never loses precision the way `usd / mark` does in a JS double.

import {
  PX_DECIMALS,
  decimalToScaled,
  scaledToDecimal,
  snapSizeToWire,
  type MarketGrid,
} from './scale.js';

/// Governed minimum inter-slice delay, node default (`twap_min_delay_ms`).
/// Governance can retune it, and no endpoint serves the live value — pass the
/// live one when you know it.
export const DEFAULT_TWAP_MIN_DELAY_MS = 10_000;

/// Target cadence used to pick a slice count: one slice per 30 s of the window.
export const DEFAULT_TWAP_TARGET_SLICE_MS = 30_000;

/// Slice-count ceiling this planner will derive. The node's own ceiling is
/// governed (`twap_max_slices`, default 10_000); this default stays well under
/// it so a governance retune downward does not start rejecting derived orders.
export const DEFAULT_TWAP_MAX_SLICES = 1_000;

/// Inputs to [`twapFromDuration`].
export interface TwapDurationRequest {
  /// Requested run time in milliseconds. The chain honours it only when the
  /// derived `delayMs` clears the floor — read `effectiveDurationMs` back.
  durationMs: number;
  /// Total USD notional to convert to a wire size. Requires `markPx` and
  /// `grid`. Omit to plan the schedule only.
  totalUsd?: string | number;
  /// Live mark price, canonical decimal string from `/info` ("64250.5").
  markPx?: string | number;
  /// Market precision grid from `/info`, used to snap the converted size onto
  /// the lot and to check `min_order`.
  grid?: MarketGrid;
  /// Governed minimum inter-slice delay in ms. Default
  /// [`DEFAULT_TWAP_MIN_DELAY_MS`].
  minDelayMs?: number;
  /// Slice-count ceiling. Default [`DEFAULT_TWAP_MAX_SLICES`].
  maxSlices?: number;
  /// Target cadence in ms. Default [`DEFAULT_TWAP_TARGET_SLICE_MS`].
  targetSliceMs?: number;
}

/// A planned TWAP: the three wire fields, plus what the chain will really do.
export interface TwapPlan {
  /// Wire `slice_count`.
  sliceCount: number;
  /// Wire `delay_ms`, already at or above the floor — the node will not move it.
  delayMs: number;
  /// Wire `total_size` in the market's lot plane. Present only when `totalUsd`,
  /// `markPx` and `grid` were all supplied. `TwapOrder.total_size` is a
  /// `number`, so widen with `Number(totalSize)`.
  totalSize?: bigint;
  /// Nominal size of one slice, the node's own `remaining / remaining_slices`
  /// toward zero with a one-unit floor. The final slice takes the remainder.
  sliceSize?: bigint;
  /// The floor raised `delayMs` above the evenly-spread value. When true the
  /// requested duration is NOT honoured — the run takes `effectiveDurationMs`.
  clampedToMinDelay: boolean;
  /// Run time the chain will really take: the first slice fires one `delayMs`
  /// after registration and the last fires at `sliceCount * delayMs`.
  effectiveDurationMs: number;
  /// The duration that was asked for, echoed for display beside the effective one.
  requestedDurationMs: number;
}

/// Derive `slice_count` / `delay_ms` (and optionally `total_size`) from a
/// duration and a USD notional.
///
/// The schedule targets one slice per `targetSliceMs`, then spreads the duration
/// evenly over the slices. When that spacing falls under the governed floor the
/// planner sheds slices first — a slower cadence over the requested window beats
/// a window that silently overruns. Only a duration under two floor-lengths
/// cannot be honoured at all; that case sets `clampedToMinDelay` and
/// `effectiveDurationMs` above `durationMs`.
///
/// Throws `RangeError` on a non-positive duration, a floor below 1 ms, a
/// `maxSlices` under 2, a USD conversion missing its mark or grid, or a
/// converted size that snaps below the market `min_order`.
export function twapFromDuration(req: TwapDurationRequest): TwapPlan {
  const requestedDurationMs = Math.trunc(req.durationMs);
  if (!Number.isFinite(requestedDurationMs) || requestedDurationMs <= 0) {
    throw new RangeError('durationMs must be a positive number of milliseconds');
  }
  const minDelayMs = Math.trunc(req.minDelayMs ?? DEFAULT_TWAP_MIN_DELAY_MS);
  if (!Number.isFinite(minDelayMs) || minDelayMs < 1) {
    throw new RangeError('minDelayMs must be at least 1');
  }
  const maxSlices = Math.trunc(req.maxSlices ?? DEFAULT_TWAP_MAX_SLICES);
  if (!Number.isFinite(maxSlices) || maxSlices < 2) {
    throw new RangeError('maxSlices must be at least 2');
  }
  const targetSliceMs = Math.trunc(req.targetSliceMs ?? DEFAULT_TWAP_TARGET_SLICE_MS);
  if (!Number.isFinite(targetSliceMs) || targetSliceMs < 1) {
    throw new RangeError('targetSliceMs must be at least 1');
  }

  let sliceCount = clamp(Math.trunc(requestedDurationMs / targetSliceMs), 2, maxSlices);
  let delayMs = Math.trunc(requestedDurationMs / sliceCount);
  if (delayMs < minDelayMs) {
    sliceCount = clamp(Math.trunc(requestedDurationMs / minDelayMs), 2, maxSlices);
    delayMs = Math.trunc(requestedDurationMs / sliceCount);
  }
  const clampedToMinDelay = delayMs < minDelayMs;
  if (clampedToMinDelay) delayMs = minDelayMs;

  const plan: TwapPlan = {
    sliceCount,
    delayMs,
    clampedToMinDelay,
    effectiveDurationMs: sliceCount * delayMs,
    requestedDurationMs,
  };

  if (req.totalUsd !== undefined) {
    if (req.markPx === undefined || req.grid === undefined) {
      throw new RangeError('totalUsd needs both markPx and grid to convert to a size');
    }
    const totalSize = usdToWireSize(req.totalUsd, req.markPx, req.grid);
    plan.totalSize = totalSize;
    plan.sliceSize = maxBig(totalSize / BigInt(sliceCount), 1n);
  }

  return plan;
}

/// Convert a USD notional to a wire `size` at the live mark, snapped onto the
/// market lot. Exact integer division toward zero — no floating point.
///
/// Throws `RangeError` on a non-positive mark, or when the snapped size falls
/// below the market `min_order`.
export function usdToWireSize(
  totalUsd: string | number,
  markPx: string | number,
  grid: MarketGrid,
): bigint {
  const usd = decimalToScaled(totalUsd, PX_DECIMALS);
  if (usd < 0n) throw new RangeError('totalUsd must not be negative');
  const mark = decimalToScaled(markPx, PX_DECIMALS);
  if (mark <= 0n) throw new RangeError('markPx must be a positive price');
  // Both sides ride the 1e8 plane, so the scale cancels and the lot plane is all
  // that is left to multiply in.
  const raw = (usd * 10n ** BigInt(grid.sz_decimals)) / mark;
  return snapSizeToWire(scaledToDecimal(raw, grid.sz_decimals), grid);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
