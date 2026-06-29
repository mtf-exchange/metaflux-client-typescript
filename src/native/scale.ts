// Decimal <-> fixed-point wire-scale conversions for order prices and sizes.
//
// The node's order wire is fixed-point: `limit_px` / `trigger_px` ride as
// integers in the 1e8 price plane (real_px = wire / 1e8, mirroring the node's
// `core_state::plane::PX_SCALE`), and `size` rides scaled by the market's
// `sz_decimals`. The /info read surface, by contrast, reports human DECIMAL
// strings ("50000.12"). These helpers bridge the two WITHOUT floating point so
// large prices/sizes never lose precision the way `humanPrice * 1e8` (a JS
// double) does above ~2^53.

import { toU64, type U64Input } from './digest.js';

/// Price plane decimals: `limit_px` / `trigger_px` are integers in the 1e8
/// fixed-point plane. Matches the node's `PX_SCALE = 1e8`.
export const PX_DECIMALS = 8;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/// Scale a human decimal value to its integer wire form in a `decimals`-digit
/// fixed-point plane, with NO floating point. Excess fractional digits beyond
/// `decimals` are truncated toward zero (the protocol's round-to-zero rule).
/// Accepts a decimal string ("50000.12") or a finite number (convenience —
/// pass a string for exact values that exceed JS double precision).
export function decimalToScaled(value: string | number, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError('decimals must be a non-negative integer');
  }
  const s = typeof value === 'number' ? numToDecimalString(value) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new RangeError(`not a decimal value: ${String(value)}`);
  const intPart = m[2] ?? '0';
  const fracTrunc = (m[3] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const mag = BigInt(intPart) * pow10(decimals) + BigInt(fracTrunc || '0');
  return m[1] === '-' ? -mag : mag;
}

/// Inverse of [`decimalToScaled`]: render an integer wire value from a
/// `decimals`-digit plane as a canonical decimal string (trailing zeros
/// stripped) — exact, no float.
///
/// SCOPE: raw fixed-point WIRE values only — e.g. echoing back a `limit_px` /
/// `size` you just built locally for display. This is NOT for `/info` or WS
/// response fields: those already arrive as canonical decimal strings, so
/// running this on them double-scales. (The read path never calls this.)
export function scaledToDecimal(wire: U64Input, decimals: number): string {
  const digits = toU64(wire, 'wire').toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const intPart = digits.slice(0, cut);
  const frac = decimals > 0 ? digits.slice(cut).replace(/0+$/, '') : '';
  return frac ? `${intPart}.${frac}` : intPart;
}

/// Human decimal price -> wire `limit_px` / `trigger_px` (1e8 plane) `bigint`.
export function pxToWire(humanPrice: string | number): bigint {
  return decimalToScaled(humanPrice, PX_DECIMALS);
}

/// Wire `limit_px` (1e8 plane) -> human decimal price string, for displaying a
/// request-plane value you built locally. NOT for `/info` / WS prices — those
/// already arrive as canonical decimal strings, so running this on them
/// double-scales.
export function wireToPx(wirePx: U64Input): string {
  return scaledToDecimal(wirePx, PX_DECIMALS);
}

/// Human decimal size -> wire `size` `bigint`, scaled by the market's
/// `sz_decimals` (from /info `MarketInfo.sz_decimals`).
export function szToWire(humanSize: string | number, szDecimals: number): bigint {
  return decimalToScaled(humanSize, szDecimals);
}

/// Wire `size` -> human decimal size string, given the market's `sz_decimals`.
/// Request-plane display only — NOT for `/info` / WS sizes, which already arrive
/// as canonical decimal strings (running this on them double-scales).
export function wireToSz(wireSize: U64Input, szDecimals: number): string {
  return scaledToDecimal(wireSize, szDecimals);
}

// ── round-to-grid ──────────────────────────────────────────────────────────
//
// The node REJECTS off-grid orders: a `limit_px` must be an exact multiple of
// the market tick and a `size` an exact multiple of the lot (`step_size`), and
// `size` must be at least `min_order`. `decimalToScaled` truncates to the plane
// decimals but does NOT snap to the tick / lot grid — these helpers do, so a
// human price/size becomes a grid-valid wire value the node accepts.
//
// PLANE BRIDGE. The market grid spec is read off `/info` `MarketInfo`:
// `tick_size` is a whole-USDC decimal ("0.01"), while the wire `limit_px` rides
// the 1e8 plane — so price snaps in the shared 1e8 integer plane. `step_size` /
// `min_order` are size-plane decimals ("0.001"), matching the wire `size` plane
// (`10^sz_decimals`) directly. The snap is toward zero (the protocol rule), so
// the result never exceeds the input.

/// The per-market precision grid the node enforces on order ingress. The shape
/// is a structural subset of `/info` `MarketInfo`, so a `MarketInfo` can be
/// passed directly.
export interface MarketGrid {
  /// Price tick (smallest increment), whole-USDC decimal string ("0.01").
  /// `"0"` means no price grid (snap is a no-op).
  tick_size: string;
  /// Size step / lot (smallest increment), size-plane decimal string ("0.001").
  /// `"0"` means no size grid (snap is a no-op).
  step_size: string;
  /// Minimum order size, size-plane decimal string. `"0"` means no minimum.
  min_order: string;
  /// Size precision — wire `size` = `whole × 10^sz_decimals`.
  sz_decimals: number;
}

/// A grid-snapped order, ready for the order wire.
export interface SnappedOrder {
  /// Snapped wire `limit_px` (1e8 plane) — an exact multiple of the tick.
  limit_px: bigint;
  /// Snapped wire `size` (`10^sz_decimals` plane) — an exact multiple of the lot.
  size: bigint;
  /// Snapped human price, canonical decimal string (display / echo).
  px: string;
  /// Snapped human size, canonical decimal string (display / echo).
  sz: string;
}

/// Snap a human price to the market tick and return the wire `limit_px` (1e8
/// plane) `bigint` — an exact multiple of the tick, snapped toward zero. A
/// `tickSize` of `"0"` (no grid) passes the price through unsnapped.
export function snapPxToWire(
  humanPrice: string | number,
  tickSize: string | number,
): bigint {
  const wire = pxToWire(humanPrice);
  const tick = decimalToScaled(tickSize, PX_DECIMALS);
  if (tick <= 0n) return wire;
  return (wire / tick) * tick;
}

/// Snap a human size to the market lot and return the wire `size`
/// (`10^sz_decimals` plane) `bigint` — an exact multiple of `step_size`, snapped
/// toward zero, with `min_order` enforced. A `step_size` of `"0"` (no grid)
/// passes the size through unsnapped. Throws `RangeError` if the snapped size is
/// below `min_order`.
export function snapSizeToWire(
  humanSize: string | number,
  grid: Pick<MarketGrid, 'step_size' | 'min_order' | 'sz_decimals'>,
): bigint {
  const szd = grid.sz_decimals;
  const raw = szToWire(humanSize, szd);
  const step = decimalToScaled(grid.step_size, szd);
  const min = decimalToScaled(grid.min_order, szd);
  const snapped = step > 0n ? (raw / step) * step : raw;
  if (min > 0n && snapped < min) {
    throw new RangeError(
      `size ${String(humanSize)} snaps to ${scaledToDecimal(snapped, szd)}, ` +
        `below min_order ${String(grid.min_order)}`,
    );
  }
  return snapped;
}

/// Snap a human `(price, size)` to a market's tick / lot grid and produce the
/// wire values the node accepts (off-grid orders are REJECTED). Opt-in: the SDK
/// never auto-snaps — call this with the market's `/info` grid before building
/// an order if you want client-side rounding. Throws if the snapped size falls
/// below `min_order`.
export function roundOrderToGrid(
  humanPrice: string | number,
  humanSize: string | number,
  grid: MarketGrid,
): SnappedOrder {
  const limit_px = snapPxToWire(humanPrice, grid.tick_size);
  const size = snapSizeToWire(humanSize, grid);
  return {
    limit_px,
    size,
    px: scaledToDecimal(limit_px, PX_DECIMALS),
    sz: scaledToDecimal(size, grid.sz_decimals),
  };
}

function numToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`${n} is not finite`);
  const s = n.toString();
  if (s.includes('e') || s.includes('E')) {
    throw new RangeError(`${n} uses exponential notation; pass a decimal string`);
  }
  return s;
}
