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
/// stripped). For DISPLAY (e.g. an order book / position px) — exact, no float.
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

/// Wire `limit_px` (1e8 plane) -> human decimal price string (for display).
export function wireToPx(wirePx: U64Input): string {
  return scaledToDecimal(wirePx, PX_DECIMALS);
}

/// Human decimal size -> wire `size` `bigint`, scaled by the market's
/// `sz_decimals` (from /info `MarketInfo.sz_decimals`).
export function szToWire(humanSize: string | number, szDecimals: number): bigint {
  return decimalToScaled(humanSize, szDecimals);
}

/// Wire `size` -> human decimal size string, given the market's `sz_decimals`.
export function wireToSz(wireSize: U64Input, szDecimals: number): string {
  return scaledToDecimal(wireSize, szDecimals);
}

function numToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`${n} is not finite`);
  const s = n.toString();
  if (s.includes('e') || s.includes('E')) {
    throw new RangeError(`${n} uses exponential notation; pass a decimal string`);
  }
  return s;
}
