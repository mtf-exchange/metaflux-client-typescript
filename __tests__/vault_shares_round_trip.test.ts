// Vault shares ride ONE plane on both the read and the write.
//
// `user_vault_equities` serves WHOLE shares and `vault_withdraw` accepts WHOLE
// shares, so a redemption must send back the exact string the read gave. Any
// rescaling, and any trip through a float, is a defect.
//
// The golden raw -> whole pairs are the node's own: the raw share counts its
// share-rendering test sweeps, converted at the 10^18 share scale. The largest
// is the 96-bit decimal-mantissa ceiling, 2^96-1. Every pair below sits at or
// under that ceiling, where the node's conversion is exact.

import { describe, it, expect } from 'vitest';
import { sharesToWire, type VaultWithdraw } from '../src/types/vault.js';
import type { VaultEquity } from '../src/types/info/hl-parity.js';

/// `[raw committed integer, the whole-share string the node serves]`.
const GOLDENS: ReadonlyArray<readonly [bigint, string]> = [
  [0n, '0'],
  [1n, '0.000000000000000001'],
  [1_000_000_000_000_000_000n, '1'],
  [12_345_000_000_000_000_000_000n, '12345'],
  [79_228_162_514_264_337_593_543_950_335n, '79228162514.264337593543950335'],
];

/// The node's conversion, reproduced in exact integer arithmetic. It proves the
/// golden strings are the raw values divided by 10^18, not numbers this test
/// invented.
function rawToWhole(raw: bigint): string {
  const scale = 10n ** 18n;
  const whole = raw / scale;
  const frac = raw % scale;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(18, '0').replace(/0+$/, '')}`;
}

describe('vault share plane', () => {
  it('the goldens are the raw share count divided by 10^18', () => {
    for (const [raw, whole] of GOLDENS) {
      expect(rawToWhole(raw)).toBe(whole);
    }
  });

  it('deposit -> read shares -> withdraw that exact string', () => {
    for (const [, whole] of GOLDENS) {
      // What `user_vault_equities` serves.
      const equity: VaultEquity = {
        vault_id: 7,
        vault_address: '0x000000000000000000000000000000000000dead',
        shares: whole,
        equity: '5000000000',
      };

      // What `vault_withdraw` sends. The read string goes through untouched.
      const withdraw: VaultWithdraw = {
        vault_id: equity.vault_id,
        shares: sharesToWire(equity.shares),
      };

      expect(withdraw.shares).toBe(whole);
    }
  });

  it('a share string never rides the wire rescaled by 10^18', () => {
    for (const [raw, whole] of GOLDENS) {
      if (raw === 0n) continue; // zero is its own raw and whole rendering
      const onWire = sharesToWire(whole);
      // The raw committed integer is what a caller sends if it wrongly treats
      // the read as 18-dec and multiplies.
      expect(onWire).not.toBe(raw.toString());
    }
  });

  it('rejects a share value handed over as a number', () => {
    // The realistic bug: a JSON reviver, or a caller reaching for a numeric
    // type. The guard catches it at the boundary instead of on the wire.
    expect(() => sharesToWire(1.5 as unknown as string)).toThrow(TypeError);
    expect(() => sharesToWire(0 as unknown as string)).toThrow(TypeError);
  });

  it('rejects exponent form, which is how a float stringifies', () => {
    expect(() => sharesToWire('1e18')).toThrow();
    expect(() => sharesToWire('1.5e-7')).toThrow();
  });

  it('shows why the string must be kept: a double cannot hold a share count', () => {
    // Not a claim about the guard — a claim about JavaScript. `sharesToWire`
    // cannot detect a value that already lost digits, because the result is
    // still a well-formed decimal string. That is the whole reason the plane
    // rule is "pass the string through untouched".
    const exact = '79228162514.264337593543950335';
    expect(String(Number(exact))).not.toBe(exact);
  });

  it('rejects a non-decimal share string', () => {
    expect(() => sharesToWire('1.2.3')).toThrow();
    expect(() => sharesToWire('abc')).toThrow();
    expect(() => sharesToWire('1e18')).toThrow();
  });
});
