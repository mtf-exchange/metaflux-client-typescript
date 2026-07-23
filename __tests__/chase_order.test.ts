// CHASE re-pricer (chase_order / cancel_chase) EIP-712 typed digest — cross-impl
// known-answer vectors, plus canonical action-JSON byte pins.
//
// CORRECTNESS GATE. Pins the TS SDK's chase_order / cancel_chase typed digest to
// the SAME value the node commits to (chain id 114514 / "Testnet"). The canonical
// params below are the golden fixtures; the digest pins are the frozen
// cross-language contract. If any digest drifts, the TS SDK is signing bytes the
// node will not verify.
//
// The GOLDEN digests were produced from the node's own EIP-712 encoder over these
// exact canonical params (owner-less + `_WITH_OWNER`, cloid present + absent).
//
// Covers:
//   (a) chase_order owner-less, cloid present
//   (b) chase_order _WITH_OWNER, cloid present (owner word at position 2)
//   (c) chase_order owner-less, cloid ABSENT (-> "" in the digest)
//   (d) cancel_chase owner-less + _WITH_OWNER

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNativeChaseOrderAction,
  buildNativeCancelChaseAction,
} from '../src/native/actions.js';
import type { ChaseOrder, CancelChase } from '../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

if (!wasmBuilt) {
  console.warn(
    '[chase_order.test.ts] pkg/ not found — skipping WASM tests. ' +
      'Run `npm run build:wasm` to enable.',
  );
}

const CHAIN_ID = 114514; // EipDomain::metaflux_v1(114514) -> chain_tag "Testnet"
const OWNER = '0x1111111111111111111111111111111111111111';
const NONCE = 1_000_000n;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// The canonical ChaseOrder fixture, minus the `owner` / `cloid` fields that vary
/// per variant.
function baseChase(): Omit<ChaseOrder, 'owner' | 'cloid'> {
  return {
    market: 3,
    side: 'bid', // NativeSide::Bid
    size: 4_000_000_000n,
    stp_mode: 'cancel_oldest', // NativeStpMode::CancelOldest
    // position_side omitted -> "" in the digest
    interval_blocks: 10,
    ttl_ms: 3_600_000n, // 1 hour
    max_reprices: 50,
  };
}

const CLOID = '0x0123456789abcdef0123456789abcdef'; // hashed verbatim as the wire string

// Frozen node golden digests (chain 114514, nonce 1_000_000, expiresAfter 0).
const GOLDEN = {
  chase_order:
    '0x0964d15a51cb61682de18fe0a61e22c5201cd9ff6db23b6c6155d1ad4b0c8038',
  chase_order_with_owner:
    '0xc4d825ceedab4c60a0a399d4fc9f865fc7aba793371ae8f7e13e8d329e0027ee',
  chase_order_no_cloid:
    '0x16763bc9cad3d8464eff642eb0f3901c07e0a5bd74e72073d639987358c0825c',
  cancel_chase:
    '0xbf40fda3e3c4c44413c430654f62c118ac577eb4666b98bd9cf0abaf4ef2c49b',
  cancel_chase_with_owner:
    '0x997fde389ac9ca5c32e28338211d678a40fcb24ac0f699252a59360539b4d82d',
} as const;

async function digestFor(
  actionType: string,
  params: ChaseOrder | CancelChase,
): Promise<string> {
  const { buildTypedOrder, typedOrderDigest } = await import(
    '../src/native/typed_orders.js'
  );
  const built = await buildTypedOrder(actionType, { params }, '', NONCE, CHAIN_ID);
  return `0x${toHex(await typedOrderDigest(built))}`;
}

describe.skipIf(!wasmBuilt)('CHASE typed digest — node golden parity', () => {
  it('(a) chase_order owner-less (cloid present) matches the golden', async () => {
    const params: ChaseOrder = { ...baseChase(), cloid: CLOID };
    expect(await digestFor('chase_order', params)).toBe(GOLDEN.chase_order);
  });

  it('(b) chase_order _WITH_OWNER (cloid present) matches the golden', async () => {
    const params: ChaseOrder = { ...baseChase(), cloid: CLOID, owner: OWNER };
    expect(await digestFor('chase_order', params)).toBe(
      GOLDEN.chase_order_with_owner,
    );
  });

  it('(c) chase_order owner-less with NO cloid (-> "") matches the golden', async () => {
    const params: ChaseOrder = { ...baseChase() };
    expect(await digestFor('chase_order', params)).toBe(GOLDEN.chase_order_no_cloid);
  });

  it('(d) cancel_chase owner-less + _WITH_OWNER match the goldens', async () => {
    const ownerLess: CancelChase = { market: 3, chase_oid: 12345 };
    const withOwner: CancelChase = { ...ownerLess, owner: OWNER };
    expect(await digestFor('cancel_chase', ownerLess)).toBe(GOLDEN.cancel_chase);
    expect(await digestFor('cancel_chase', withOwner)).toBe(
      GOLDEN.cancel_chase_with_owner,
    );
  });

  it('the owner-less and _WITH_OWNER digests differ (owner word is bound)', async () => {
    const ownerLess = await digestFor('chase_order', {
      ...baseChase(),
      cloid: CLOID,
    });
    const withOwner = await digestFor('chase_order', {
      ...baseChase(),
      cloid: CLOID,
      owner: OWNER,
    });
    expect(ownerLess).not.toBe(withOwner);
    expect(ownerLess).toBe(GOLDEN.chase_order);
    expect(withOwner).toBe(GOLDEN.chase_order_with_owner);
  });

  it('the cloid is bound (present vs absent digests differ)', async () => {
    const withCloid = await digestFor('chase_order', {
      ...baseChase(),
      cloid: CLOID,
    });
    const noCloid = await digestFor('chase_order', { ...baseChase() });
    expect(withCloid).not.toBe(noCloid);
    expect(withCloid).toBe(GOLDEN.chase_order);
    expect(noCloid).toBe(GOLDEN.chase_order_no_cloid);
  });

  it('each chase field is bound (a changed value moves the digest)', async () => {
    const base: ChaseOrder = { ...baseChase(), cloid: CLOID };
    const ref = await digestFor('chase_order', base);
    // Vary one field at a time; every one must perturb the digest.
    const variants: ChaseOrder[] = [
      { ...base, size: 4_000_000_001n },
      { ...base, side: 'ask' },
      { ...base, stp_mode: 'cancel_newest' },
      { ...base, interval_blocks: 11 },
      { ...base, ttl_ms: 3_600_001n },
      { ...base, max_reprices: 51 },
      { ...base, position_side: 'long' },
    ];
    for (const v of variants) {
      expect(await digestFor('chase_order', v)).not.toBe(ref);
    }
  });
});

// The canonical action JSON is pure string assembly (no WASM), so these always
// run. The bytes here are BOTH what gets signed and what gets POSTed.
describe('CHASE canonical action JSON — byte pins', () => {
  it('chase_order owner-less omits owner (cloid present, no position_side)', () => {
    const json = buildNativeChaseOrderAction({ ...baseChase(), cloid: CLOID });
    expect(json).toBe(
      '{"type":"chase_order","params":{"market":3,"side":"bid","size":4000000000,' +
        '"cloid":"0x0123456789abcdef0123456789abcdef","stp_mode":"cancel_oldest",' +
        '"interval_blocks":10,"ttl_ms":3600000,"max_reprices":50}}',
    );
  });

  it('chase_order _WITH_OWNER puts owner first', () => {
    const json = buildNativeChaseOrderAction({
      ...baseChase(),
      cloid: CLOID,
      owner: OWNER,
    });
    expect(json).toBe(
      '{"type":"chase_order","params":{"owner":"0x1111111111111111111111111111111111111111",' +
        '"market":3,"side":"bid","size":4000000000,' +
        '"cloid":"0x0123456789abcdef0123456789abcdef","stp_mode":"cancel_oldest",' +
        '"interval_blocks":10,"ttl_ms":3600000,"max_reprices":50}}',
    );
  });

  it('chase_order omits an absent cloid and rides position_side after stp_mode', () => {
    const json = buildNativeChaseOrderAction({
      ...baseChase(),
      position_side: 'long',
    });
    expect(json).toBe(
      '{"type":"chase_order","params":{"market":3,"side":"bid","size":4000000000,' +
        '"stp_mode":"cancel_oldest","position_side":"long",' +
        '"interval_blocks":10,"ttl_ms":3600000,"max_reprices":50}}',
    );
  });

  it('cancel_chase owner-less + _WITH_OWNER byte pins', () => {
    expect(buildNativeCancelChaseAction({ market: 3, chase_oid: 12345 })).toBe(
      '{"type":"cancel_chase","params":{"market":3,"chase_oid":12345}}',
    );
    expect(
      buildNativeCancelChaseAction({ market: 3, chase_oid: 12345, owner: OWNER }),
    ).toBe(
      '{"type":"cancel_chase","params":{"owner":"0x1111111111111111111111111111111111111111",' +
        '"market":3,"chase_oid":12345}}',
    );
  });

  it('rejects out-of-range chase params before signing', () => {
    expect(() => buildNativeChaseOrderAction({ ...baseChase(), size: 0 })).toThrow(
      /size > 0/,
    );
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), interval_blocks: 1 }),
    ).toThrow(/interval_blocks must be in 2..=28800/);
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), interval_blocks: 28_801 }),
    ).toThrow(/interval_blocks must be in 2..=28800/);
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), ttl_ms: 59_999n }),
    ).toThrow(/ttl_ms must be in 60000..=604800000/);
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), ttl_ms: 604_800_001n }),
    ).toThrow(/ttl_ms must be in 60000..=604800000/);
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), max_reprices: 0 }),
    ).toThrow(/max_reprices must be in 1..=100000/);
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), max_reprices: 100_001 }),
    ).toThrow(/max_reprices must be in 1..=100000/);
    expect(() =>
      buildNativeChaseOrderAction({ ...baseChase(), cloid: '0xdead' }),
    ).toThrow(/cloid/);
  });
});
