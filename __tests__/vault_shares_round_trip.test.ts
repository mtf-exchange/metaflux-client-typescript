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
import {
  sharesToWire,
  rawShares,
  rawSharesToWhole,
  type Raw1e18,
  type VaultWithdraw,
} from '../src/types/vault.js';
import type { VaultEquity } from '../src/types/info/hl-parity.js';
import type { Client } from '../src/client.js';

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

describe('rawSharesToWhole is the one exit from the raw plane', () => {
  it('reproduces the node string for every golden', () => {
    for (const [raw, whole] of GOLDENS) {
      // Asserted against the LITERAL golden, not against this file's
      // `rawToWhole`. Comparing two runs of the same algorithm proves nothing.
      expect(rawSharesToWhole(rawShares(raw))).toBe(whole);
    }
  });

  it('feeds a wire share string that survives the redemption round trip', () => {
    for (const [raw, whole] of GOLDENS) {
      const withdraw: VaultWithdraw = {
        vault_id: 7,
        shares: sharesToWire(rawSharesToWhole(rawShares(raw))),
      };
      expect(withdraw.shares).toBe(whole);
    }
  });

  it('is exact where a float divide is not', () => {
    const raw = rawShares('79228162514264337593543950335');
    expect(rawSharesToWhole(raw)).toBe('79228162514.264337593543950335');
    // The same divide in a double. It agrees to about 17 digits, then invents.
    expect(String(Number(raw) / 1e18)).not.toBe('79228162514.264337593543950335');
  });

  it('accepts a bigint, which is how an EVM read arrives', () => {
    expect(rawShares(12_345_000_000_000_000_000_000n)).toBe('12345000000000000000000');
    expect(rawSharesToWhole(rawShares(1n))).toBe('0.000000000000000001');
  });

  it('refuses anything that is not a non-negative integer', () => {
    expect(() => rawShares('-1')).toThrow(TypeError);
    expect(() => rawShares(-1n)).toThrow(TypeError);
    expect(() => rawShares('1.5')).toThrow(TypeError);
    expect(() => rawShares('1e18')).toThrow(TypeError);
    expect(() => rawShares('abc')).toThrow(TypeError);
    expect(() => rawShares(1 as unknown as string)).toThrow(TypeError);
  });

  it('re-checks its input, because a cast can forge the brand', () => {
    expect(() => rawSharesToWhole('1.5' as Raw1e18)).toThrow(TypeError);
  });
});

// The plane split is a TYPE guarantee, not a runtime check. `tsc` runs over
// this file (tsconfig.test.json), so a `@ts-expect-error` that stops erroring
// fails the typecheck gate.
//
// No runtime check can do this job. `'1000000000000000000'` is also a legal
// whole-share count, so only the brand separates the two planes.
describe('the raw 1e18 plane cannot reach the wire', () => {
  const raw: Raw1e18 = rawShares('1000000000000000000');

  it('sharesToWire refuses a raw share count', () => {
    // @ts-expect-error a Raw1e18 is the committed plane, not the wire plane
    const bad = sharesToWire(raw);
    // The runtime accepts it: this string is a well-formed decimal. The
    // compiler is the only layer that can tell the planes apart.
    expect(bad).toBe('1000000000000000000');
  });

  it('vault_withdraw refuses a raw share count', () => {
    const bad: VaultWithdraw = {
      vault_id: 7,
      // @ts-expect-error vault_withdraw reads the WHOLE-share plane
      shares: raw,
    };
    expect(bad.shares).toBe('1000000000000000000');
  });

  it('accepts the same value once it is converted', () => {
    const withdraw: VaultWithdraw = {
      vault_id: 7,
      shares: sharesToWire(rawSharesToWhole(raw)),
    };
    expect(withdraw.shares).toBe('1');
  });

  it('still accepts a plain string, so no existing caller breaks', () => {
    const fromJson: string = '12345';
    const withdraw: VaultWithdraw = { vault_id: 7, shares: fromJson };
    expect(sharesToWire(fromJson)).toBe('12345');
    expect(withdraw.shares).toBe('12345');
  });

  // `client.vaultWithdraw` is the entry point a caller reaches for. Pin the
  // wall there too, so widening that signature also fails the gate.
  it('client.vaultWithdraw refuses a raw share count', () => {
    type WithdrawParams = Parameters<Client['vaultWithdraw']>[0];
    const bad: WithdrawParams = {
      vault_id: 7,
      // @ts-expect-error the client entry point reads the WHOLE-share plane
      shares: raw,
    };
    const good: WithdrawParams = { vault_id: 7, shares: rawSharesToWhole(raw) };
    expect(bad.shares).toBe('1000000000000000000');
    expect(good.shares).toBe('1');
  });
});
