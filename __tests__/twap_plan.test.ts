// TWAP planning: duration -> (slice_count, delay_ms), USD -> total_size, and
// the governed minimum-delay floor being SURFACED rather than swallowed.

import { describe, expect, it } from 'vitest';

const GRID = {
  tick_size: '0.1',
  step_size: '0.001',
  min_order: '0.001',
  sz_decimals: 3,
};

describe('twapFromDuration: schedule', () => {
  it('targets one slice per 30 s and spreads the duration evenly', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    const p = twapFromDuration({ durationMs: 30 * 60_000 });
    expect(p.sliceCount).toBe(60);
    expect(p.delayMs).toBe(30_000);
    expect(p.clampedToMinDelay).toBe(false);
    expect(p.effectiveDurationMs).toBe(30 * 60_000);
    expect(p.requestedDurationMs).toBe(30 * 60_000);
  });

  it('never derives fewer than two slices', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    const p = twapFromDuration({ durationMs: 30_000 });
    expect(p.sliceCount).toBe(2);
    expect(p.delayMs).toBe(15_000);
    expect(p.clampedToMinDelay).toBe(false);
  });

  it('caps the slice count and stretches the delay to keep the window', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    const p = twapFromDuration({ durationMs: 100 * 60 * 60_000, maxSlices: 1_000 });
    expect(p.sliceCount).toBe(1_000);
    expect(p.delayMs).toBe(360_000);
    expect(p.effectiveDurationMs).toBe(100 * 60 * 60_000);
  });

  it('sheds slices rather than overrun when the floor is above the cadence', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    // A 5-minute window with a 60 s governed floor: 10 slices at 30 s would be
    // clamped up to 60 s each and run 10 minutes. Five slices honour the window.
    const p = twapFromDuration({ durationMs: 5 * 60_000, minDelayMs: 60_000 });
    expect(p.sliceCount).toBe(5);
    expect(p.delayMs).toBe(60_000);
    expect(p.clampedToMinDelay).toBe(false);
    expect(p.effectiveDurationMs).toBe(5 * 60_000);
  });
});

describe('twapFromDuration: the floor is surfaced, never hidden', () => {
  it('reports the clamp and the LONGER real run time', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    // 15 s asked for; two slices cannot be spaced closer than the 10 s floor.
    const p = twapFromDuration({ durationMs: 15_000 });
    expect(p.clampedToMinDelay).toBe(true);
    expect(p.delayMs).toBe(10_000);
    expect(p.sliceCount).toBe(2);
    expect(p.requestedDurationMs).toBe(15_000);
    expect(p.effectiveDurationMs).toBe(20_000);
    expect(p.effectiveDurationMs).toBeGreaterThan(p.requestedDurationMs);
  });

  it('emits a delay the node will not move, so the plan is the truth', async () => {
    const { twapFromDuration, DEFAULT_TWAP_MIN_DELAY_MS } = await import(
      '../src/native/twap_plan.js'
    );
    for (const durationMs of [1, 999, 15_000, 60_000, 3_600_000, 86_400_000]) {
      const p = twapFromDuration({ durationMs });
      expect(p.delayMs, `duration ${durationMs}`).toBeGreaterThanOrEqual(
        DEFAULT_TWAP_MIN_DELAY_MS,
      );
      // The node stamps `max(requested, floor)`, so a plan at or above the floor
      // survives registration unchanged and the run time below is exact.
      expect(p.effectiveDurationMs).toBe(p.sliceCount * p.delayMs);
    }
  });

  it('honours a governed floor passed in place of the default', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    const p = twapFromDuration({ durationMs: 60_000, minDelayMs: 120_000 });
    expect(p.clampedToMinDelay).toBe(true);
    expect(p.delayMs).toBe(120_000);
    expect(p.effectiveDurationMs).toBe(240_000);
  });
});

describe('usdToWireSize: USD -> size at the live mark', () => {
  it('divides in the shared 1e8 plane with no float', async () => {
    const { usdToWireSize } = await import('../src/native/twap_plan.js');
    expect(usdToWireSize('64250', '64250', GRID)).toBe(1_000n);
    expect(usdToWireSize('32125', '64250', GRID)).toBe(500n);
  });

  it('keeps precision a double would lose', async () => {
    const { usdToWireSize } = await import('../src/native/twap_plan.js');
    // 0.1 + 0.2 arithmetic in a double misses this by a lot unit.
    expect(usdToWireSize('0.3', '1', { ...GRID, step_size: '0.001' })).toBe(300n);
    const big = usdToWireSize('123456789.12345678', '1.00000001', {
      ...GRID,
      sz_decimals: 8,
      step_size: '0.00000001',
      min_order: '0.00000001',
    });
    expect(big).toBe((12_345_678_912_345_678n * 100_000_000n) / 100_000_001n);
  });

  it('snaps toward zero onto the market lot', async () => {
    const { usdToWireSize } = await import('../src/native/twap_plan.js');
    // 1.9999 coin at a lot of 0.001 -> 1.999, never rounded up.
    expect(usdToWireSize('1.9999', '1', GRID)).toBe(1_999n);
  });

  it('rejects a non-positive mark and a below-minimum size', async () => {
    const { usdToWireSize } = await import('../src/native/twap_plan.js');
    expect(() => usdToWireSize('100', '0', GRID)).toThrow(RangeError);
    expect(() => usdToWireSize('0.0001', '1', GRID)).toThrow(RangeError);
  });
});

describe('twapFromDuration: sizing together with the schedule', () => {
  it('returns the wire total and the node-shaped nominal slice', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    const p = twapFromDuration({
      durationMs: 30 * 60_000,
      totalUsd: '64250',
      markPx: '64250',
      grid: GRID,
    });
    expect(p.totalSize).toBe(1_000n);
    expect(p.sliceCount).toBe(60);
    // The node fires `remaining / remaining_slices` toward zero; 1000/60 = 16.
    expect(p.sliceSize).toBe(16n);
  });

  it('floors the nominal slice at one wire unit like the node does', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    const p = twapFromDuration({
      durationMs: 30 * 60_000,
      totalUsd: '0.01',
      markPx: '1',
      grid: { ...GRID, min_order: '0' },
    });
    expect(p.totalSize).toBe(10n);
    expect(p.sliceSize).toBe(1n);
  });

  it('refuses a USD amount with no mark or no grid', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    expect(() => twapFromDuration({ durationMs: 60_000, totalUsd: '100' })).toThrow(RangeError);
    expect(() =>
      twapFromDuration({ durationMs: 60_000, totalUsd: '100', markPx: '1' }),
    ).toThrow(RangeError);
  });

  it('rejects a non-positive duration and a degenerate cap', async () => {
    const { twapFromDuration } = await import('../src/native/twap_plan.js');
    expect(() => twapFromDuration({ durationMs: 0 })).toThrow(RangeError);
    expect(() => twapFromDuration({ durationMs: -1 })).toThrow(RangeError);
    expect(() => twapFromDuration({ durationMs: 60_000, maxSlices: 1 })).toThrow(RangeError);
    expect(() => twapFromDuration({ durationMs: 60_000, minDelayMs: 0 })).toThrow(RangeError);
  });
});
