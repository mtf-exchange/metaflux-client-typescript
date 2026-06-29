// Price/size precision: decimal <-> wire-scale helpers, and the guarantee that
// a u64 wire field encodes IDENTICALLY whether passed as number, bigint, or
// string (so the precision fix never drifts the signed bytes).

import { describe, expect, it } from 'vitest';

const ADDR = '0x1111111111111111111111111111111111111111';

function order(over: Record<string, unknown>) {
  return {
    owner: ADDR,
    market: 1,
    side: 'bid',
    kind: 'limit',
    size: 1000,
    limit_px: 5000,
    tif: 'gtc',
    stp_mode: 'cancel_oldest',
    reduce_only: false,
    ...over,
  };
}

describe('scale: decimal <-> fixed-point wire', () => {
  it('decimalToScaled scales by the plane decimals (no float)', async () => {
    const { decimalToScaled, pxToWire } = await import('../src/native/scale.js');
    expect(decimalToScaled('1', 8)).toBe(100_000_000n);
    expect(decimalToScaled('50000.12', 8)).toBe(5_000_012_000_000n);
    expect(decimalToScaled('0.00000001', 8)).toBe(1n);
    expect(pxToWire('50000.12')).toBe(5_000_012_000_000n);
    // Convenience number input.
    expect(pxToWire(0.5)).toBe(50_000_000n);
  });

  it('truncates toward zero beyond the plane precision', async () => {
    const { decimalToScaled } = await import('../src/native/scale.js');
    expect(decimalToScaled('1.123456789', 8)).toBe(112_345_678n); // 9th frac digit dropped
    expect(decimalToScaled('1.999999999', 8)).toBe(199_999_999n);
  });

  it('scaledToDecimal is the exact inverse (trailing zeros stripped)', async () => {
    const { scaledToDecimal, wireToPx, szToWire, wireToSz } = await import(
      '../src/native/scale.js'
    );
    expect(scaledToDecimal(100_000_000n, 8)).toBe('1');
    expect(wireToPx(5_000_012_000_000n)).toBe('50000.12');
    expect(wireToPx('1')).toBe('0.00000001');
    expect(szToWire('1.5', 3)).toBe(1500n);
    expect(wireToSz(1500n, 3)).toBe('1.5');
  });

  it('survives values beyond JS double precision (2^53)', async () => {
    const { pxToWire, wireToPx } = await import('../src/native/scale.js');
    // A price whose 1e8 wire value exceeds Number.MAX_SAFE_INTEGER.
    const human = '123456789.12345678';
    const wire = pxToWire(human); // 12_345_678_912_345_678n
    expect(wire).toBe(12_345_678_912_345_678n);
    expect(wire > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(wireToPx(wire)).toBe(human);
  });

  it('rejects exponential-notation numbers (force a string)', async () => {
    const { decimalToScaled } = await import('../src/native/scale.js');
    expect(() => decimalToScaled(1e21, 8)).toThrow();
  });
});

describe('round-to-grid: snap px/size to the market tick / lot', () => {
  const grid = {
    tick_size: '0.01', // whole-USDC price tick
    step_size: '0.001', // size-plane lot
    min_order: '0.01', // size-plane minimum
    sz_decimals: 3,
  };

  it('snaps px to a tick multiple (toward zero) and returns the 1e8 wire', async () => {
    const { snapPxToWire } = await import('../src/native/scale.js');
    // 67042.579 at a $0.01 tick → 67042.57 → wire 1e8.
    expect(snapPxToWire('67042.579', '0.01')).toBe(6_704_257_000_000n);
    // Already on grid is unchanged.
    expect(snapPxToWire('67042.57', '0.01')).toBe(6_704_257_000_000n);
    // A coarse tick snaps harder: $0.5 tick, 100.9 → 100.5.
    expect(snapPxToWire('100.9', '0.5')).toBe(10_050_000_000n);
    // tick "0" = no grid → straight pxToWire.
    expect(snapPxToWire('1.23456789', '0')).toBe(123_456_789n);
  });

  it('snaps size to a lot multiple (toward zero) and returns the wire size', async () => {
    const { snapSizeToWire } = await import('../src/native/scale.js');
    // 1.2349 at a 0.001 lot, szd=3 → 1.234 → 1234 raw.
    expect(snapSizeToWire('1.2349', grid)).toBe(1234n);
    // On-grid unchanged.
    expect(snapSizeToWire('1.234', grid)).toBe(1234n);
    // step "0" = no grid → straight szToWire (truncate to szd).
    expect(snapSizeToWire('1.2349', { ...grid, step_size: '0' })).toBe(1234n);
  });

  it('enforces min_order (throws below the minimum)', async () => {
    const { snapSizeToWire } = await import('../src/native/scale.js');
    // 0.005 snaps to 0.005 (>= 0.001 lot) but is below the 0.01 minimum.
    expect(() => snapSizeToWire('0.005', grid)).toThrow(/min_order/);
    // Exactly at the minimum is fine.
    expect(snapSizeToWire('0.01', grid)).toBe(10n);
  });

  it('roundOrderToGrid returns wire bigints plus snapped decimal strings', async () => {
    const { roundOrderToGrid } = await import('../src/native/scale.js');
    const out = roundOrderToGrid('67042.579', '1.2349', grid);
    expect(out.limit_px).toBe(6_704_257_000_000n);
    expect(out.size).toBe(1234n);
    expect(out.px).toBe('67042.57');
    expect(out.sz).toBe('1.234');
  });

  it('snaps losslessly above JS double precision', async () => {
    const { snapPxToWire } = await import('../src/native/scale.js');
    // Off-grid in the 9th decimal, beyond 2^53 once on the 1e8 wire.
    const wire = snapPxToWire('123456789.123456789', '0.01');
    expect(wire).toBe(12_345_678_912_000_000n);
    expect(wire > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('toU64: number | bigint | string normalize identically', () => {
  it('same bigint for every representation of one value', async () => {
    const { toU64 } = await import('../src/native/digest.js');
    expect(toU64(5000, 'x')).toBe(5000n);
    expect(toU64(5000n, 'x')).toBe(5000n);
    expect(toU64('5000', 'x')).toBe(5000n);
  });

  it('rejects a number above 2^53 (no silent precision loss)', async () => {
    const { toU64 } = await import('../src/native/digest.js');
    expect(() => toU64(2 ** 53 + 1, 'x')).toThrow();
    // ...but a bigint / string of the same magnitude is fine.
    expect(toU64(9_007_199_254_740_993n, 'x')).toBe(9_007_199_254_740_993n);
    expect(toU64('9007199254740993', 'x')).toBe(9_007_199_254_740_993n);
  });

  it('rejects out-of-range and malformed inputs', async () => {
    const { toU64 } = await import('../src/native/digest.js');
    expect(() => toU64(-1n, 'x')).toThrow();
    expect(() => toU64(1n << 64n, 'x')).toThrow();
    expect(() => toU64('1.5', 'x')).toThrow();
    expect(() => toU64('0x10', 'x')).toThrow();
  });
});

describe('order wire bytes are identical across number/bigint/string', () => {
  it('submit_order: number == bigint == string for the same px/size', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    const asNum = buildNativeOrderAction(order({ size: 1000, limit_px: 5000 }) as never);
    const asBig = buildNativeOrderAction(order({ size: 1000n, limit_px: 5000n }) as never);
    const asStr = buildNativeOrderAction(order({ size: '1000', limit_px: '5000' }) as never);
    expect(asBig).toBe(asNum);
    expect(asStr).toBe(asNum);
    // The wire carries bare integers (not quoted strings).
    expect(asNum).toContain('"size":1000,"limit_px":5000');
  });

  it('normalizes a non-canonical integer string to the canonical wire form', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    const canon = buildNativeOrderAction(order({ limit_px: 5000 }) as never);
    const leadingZeros = buildNativeOrderAction(order({ limit_px: '05000' }) as never);
    expect(leadingZeros).toBe(canon); // "05000" -> 5000, wire stays "5000"
  });

  it('carries a >2^53 price as a bare integer without precision loss', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    const wire = buildNativeOrderAction(
      order({ limit_px: 12_345_678_912_345_678n }) as never,
    );
    expect(wire).toContain('"limit_px":12345678912345678');
  });
});
