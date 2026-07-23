// SCALE ladder (scale_order / cancel_scale) EIP-712 typed digest — cross-impl
// known-answer vectors.
//
// CORRECTNESS GATE. Pins the TS SDK's scale_order / cancel_scale typed digest to
// the SAME value the server commits to (chain id 114514 / "Testnet"). The
// canonical params below are the server's golden fixtures; the digest pins are
// the frozen cross-language contract. If any digest drifts, the TS SDK is
// signing bytes the node will not verify.
//
// Covers all four required variants under ONE set of canonical params:
//   (a) owner-less non-custom (dist "lin_desc", empty weights -> zero hash)
//   (b) _WITH_OWNER non-custom (owner word at position 2)
//   (c) owner-less custom (weights [1,2,3,4] -> keccak256(uint256 words))
//   (d) cancel_scale owner-less + _WITH_OWNER

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScaleOrder, CancelScale } from '../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

if (!wasmBuilt) {
  console.warn(
    '[scale_order.test.ts] pkg/ not found — skipping WASM tests. ' +
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

/// The server's canonical ScaleOrder fixture, minus the `dist` / `weights` /
/// `owner` fields that vary per variant.
function baseScale(): Omit<ScaleOrder, 'dist' | 'weights' | 'owner'> {
  return {
    market: 3,
    side: 'bid', // NativeSide::Bid
    n: 4,
    px_low: 300_000_000_000n, // 3000.0 on the 1e8 plane
    px_high: 330_000_000_000n, // 3300.0 on the 1e8 plane
    total_size: 4_000_000_000n,
    tif: 'alo', // NativeTif::Alo
    reduce_only: false,
    stp_mode: 'cancel_oldest', // NativeStpMode::CancelOldest
    // position_side omitted -> "" in the digest
    cloid: '0x0123456789abcdef0123456789abcdef', // hashed verbatim as the wire string
  };
}

// Frozen server golden digests (chain 114514, nonce 1_000_000, expiresAfter 0).
const GOLDEN = {
  scale_order:
    '0xe9aee770dc5e781823b5bdf4d33390ce8b08a1838e01eee3fa3481e3710549ab',
  scale_order_with_owner:
    '0x7d52e8d5ddd55cdb59765dbaec525a68aa4b28eb60b71746fe13fcc0708aa5eb',
  scale_order_custom:
    '0x7a6646b5f774b5aff1cb23c636c0351a92ee3feee1144823840a63a705b9bfd3',
  cancel_scale:
    '0xc98bde278b2b83d4b822ee9c8245de6550d031440dd8641cd6e43b00d65e9d6d',
  cancel_scale_with_owner:
    '0xe5f38a51f8c3b4b899af7b0d7bdabc0256fba80cd09d211881fc8a3bbdb9d5d0',
} as const;

async function digestFor(
  actionType: string,
  params: ScaleOrder | CancelScale,
): Promise<string> {
  const { buildTypedOrder, typedOrderDigest } = await import(
    '../src/native/typed_orders.js'
  );
  const built = await buildTypedOrder(actionType, { params }, '', NONCE, CHAIN_ID);
  return `0x${toHex(await typedOrderDigest(built))}`;
}

describe.skipIf(!wasmBuilt)('SCALE ladder typed digest — server golden parity', () => {
  it('(a) scale_order owner-less non-custom (lin_desc) matches the golden', async () => {
    const params: ScaleOrder = { ...baseScale(), dist: 'lin_desc' };
    expect(await digestFor('scale_order', params)).toBe(GOLDEN.scale_order);
  });

  it('(b) scale_order _WITH_OWNER non-custom matches the golden', async () => {
    const params: ScaleOrder = { ...baseScale(), dist: 'lin_desc', owner: OWNER };
    expect(await digestFor('scale_order', params)).toBe(
      GOLDEN.scale_order_with_owner,
    );
  });

  it('(c) scale_order owner-less custom (weights [1,2,3,4]) matches the golden', async () => {
    const params: ScaleOrder = {
      ...baseScale(),
      dist: 'custom',
      weights: [1, 2, 3, 4],
    };
    expect(await digestFor('scale_order', params)).toBe(GOLDEN.scale_order_custom);
  });

  it('(d) cancel_scale owner-less + _WITH_OWNER match the goldens', async () => {
    const ownerLess: CancelScale = {
      market: 3,
      cloid: '0x0123456789abcdef0123456789abcdef',
    };
    const withOwner: CancelScale = { ...ownerLess, owner: OWNER };
    expect(await digestFor('cancel_scale', ownerLess)).toBe(GOLDEN.cancel_scale);
    expect(await digestFor('cancel_scale', withOwner)).toBe(
      GOLDEN.cancel_scale_with_owner,
    );
  });

  it('the owner-less and _WITH_OWNER digests differ (owner word is bound)', async () => {
    const ownerLess = await digestFor('scale_order', {
      ...baseScale(),
      dist: 'lin_desc',
    });
    const withOwner = await digestFor('scale_order', {
      ...baseScale(),
      dist: 'lin_desc',
      owner: OWNER,
    });
    expect(ownerLess).not.toBe(withOwner);
    expect(ownerLess).toBe(GOLDEN.scale_order);
    expect(withOwner).toBe(GOLDEN.scale_order_with_owner);
  });
});
