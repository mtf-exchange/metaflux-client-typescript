// Real-node native write-action builders — JSON-shape pins + a sign/recover
// round-trip. Covers a representative slice of the reconciled /exchange surface
// (vaults, leverage/margin, TWAP, staking, MetaBridge, encrypted, batch). The
// 5 original builders are byte-pinned separately in `native.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeOrder } from '../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

// MTF testnet chain id (114514) — the SDK default.
const KAT_CHAIN_ID = 114514;

const ADDR = '0x000000000000000000000000000000000000beef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// Derive the signer's own 0x address from a fixed private key.
async function signerAddress(privKey: Uint8Array): Promise<string> {
  const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
    await import('../src/wallet/wasm.js');
  const probeDigest = await keccak256(new TextEncoder().encode('probe'));
  const probeSig = await signSecp256k1(privKey, probeDigest);
  const probePub = await recoverPubkey(probeSig, probeDigest);
  return `0x${toHex(await deriveAddressFromPubkey(probePub))}`;
}

describe('real native write-action builders (JSON shape)', () => {
  it('create_vault: omits parent, defaults kind to "User"', async () => {
    const { buildNativeCreateVaultAction } = await import('../src/native/actions.js');
    expect(
      buildNativeCreateVaultAction({ name: 'mlp', lock_period_secs: 604800 }),
    ).toBe(
      '{"type":"create_vault","params":{"name":"mlp","lock_period_secs":604800,"kind":"User"}}',
    );
  });

  it('create_vault: emits parent + explicit kind', async () => {
    const { buildNativeCreateVaultAction } = await import('../src/native/actions.js');
    expect(
      buildNativeCreateVaultAction({
        name: 'v',
        lock_period_secs: 1,
        parent: 3,
        kind: 'Metaliquidity',
      }),
    ).toBe(
      '{"type":"create_vault","params":{"name":"v","lock_period_secs":1,"parent":3,"kind":"Metaliquidity"}}',
    );
  });

  it('vault_withdraw: shares as a decimal string', async () => {
    const { buildNativeVaultWithdrawAction } = await import('../src/native/actions.js');
    expect(buildNativeVaultWithdrawAction({ vault_id: 7, shares: '250.5' })).toBe(
      '{"type":"vault_withdraw","params":{"vault_id":7,"shares":"250.5"}}',
    );
  });

  it('update_leverage: snake_case integers + bool', async () => {
    const { buildNativeUpdateLeverageAction } = await import('../src/native/actions.js');
    expect(
      buildNativeUpdateLeverageAction({ asset: 2, leverage: 10, is_isolated: true }),
    ).toBe(
      '{"type":"update_leverage","params":{"asset":2,"leverage":10,"is_isolated":true}}',
    );
  });

  it('update_isolated_margin: signed delta as a string', async () => {
    const { buildNativeUpdateIsolatedMarginAction } = await import(
      '../src/native/actions.js'
    );
    expect(
      buildNativeUpdateIsolatedMarginAction({ asset: 1, delta: '-12.5' }),
    ).toBe(
      '{"type":"update_isolated_margin","params":{"asset":1,"delta":"-12.5"}}',
    );
  });

  it('twap_order: full slice shape', async () => {
    const { buildNativeTwapOrderAction } = await import('../src/native/actions.js');
    expect(
      buildNativeTwapOrderAction({
        market: 4,
        side: 'ask',
        total_size: 1000,
        slice_count: 10,
        delay_ms: 500,
        reduce_only: true,
      }),
    ).toBe(
      '{"type":"twap_order","params":{"market":4,"side":"ask","total_size":1000,"slice_count":10,"delay_ms":500,"reduce_only":true}}',
    );
  });

  it('token_delegate: decimal amount + bool', async () => {
    const { buildNativeTokenDelegateAction } = await import('../src/native/actions.js');
    expect(
      buildNativeTokenDelegateAction({
        validator: ADDR,
        amount: '100.5',
        is_undelegate: false,
      }),
    ).toBe(
      `{"type":"token_delegate","params":{"validator":"${ADDR}","amount":"100.5","is_undelegate":false}}`,
    );
  });

  it('mb_withdraw: PascalCase chain + 20-byte dst_addr', async () => {
    const { buildNativeMbWithdrawAction } = await import('../src/native/actions.js');
    const dst = '0xabababababababababababababababababababab';
    expect(
      buildNativeMbWithdrawAction({ chain: 'Base', asset: 0, amount: 1000000, dst_addr: dst }),
    ).toBe(
      `{"type":"mb_withdraw","params":{"chain":"Base","asset":0,"amount":1000000,"dst_addr":"${dst}"}}`,
    );
  });

  it('submit_encrypted_order: ciphertext + 32-byte commitment as byte arrays', async () => {
    const { buildNativeSubmitEncryptedOrderAction } = await import(
      '../src/native/actions.js'
    );
    const commitment = '[' + new Array(32).fill(0).join(',') + ']';
    expect(
      buildNativeSubmitEncryptedOrderAction({
        ciphertext: new Uint8Array([1, 2, 255]),
        commitment: new Uint8Array(32),
        threshold: 2,
        target_block: 100,
        reveal_deadline_ms: 5000,
      }),
    ).toBe(
      `{"type":"submit_encrypted_order","params":{"ciphertext":[1,2,255],"commitment":${commitment},"threshold":2,"target_block":100,"reveal_deadline_ms":5000}}`,
    );
  });

  it('submit_encrypted_order: rejects a non-32-byte commitment', async () => {
    const { buildNativeSubmitEncryptedOrderAction } = await import(
      '../src/native/actions.js'
    );
    expect(() =>
      buildNativeSubmitEncryptedOrderAction({
        ciphertext: new Uint8Array([1]),
        commitment: new Uint8Array(16),
        threshold: 1,
        target_block: 1,
        reveal_deadline_ms: 1,
      }),
    ).toThrow();
  });

  it('batch_order: array of order bodies + default grouping', async () => {
    const { buildNativeBatchOrderAction } = await import('../src/native/actions.js');
    expect(
      buildNativeBatchOrderAction({
        orders: [
          {
            owner: ADDR,
            market: 1,
            side: 'bid',
            kind: 'limit',
            size: 1000,
            limit_px: 5000,
            tif: 'gtc',
            stp_mode: 'cancel_oldest',
            reduce_only: false,
          },
        ],
      }),
    ).toBe(
      `{"type":"batch_order","params":{"orders":[{"owner":"${ADDR}","market":1,"side":"bid","kind":"limit","size":1000,"limit_px":5000,"tif":"gtc","stp_mode":"cancel_oldest","reduce_only":false}],"grouping":"na"}}`,
    );
  });

  it('cancel_all_orders: empty params when no asset filter', async () => {
    const { buildNativeCancelAllOrdersAction } = await import(
      '../src/native/actions.js'
    );
    expect(buildNativeCancelAllOrdersAction()).toBe(
      '{"type":"cancel_all_orders","params":{}}',
    );
  });
});

describe('forward-compat write-action builders (cross-chain / vault_distribute)', () => {
  it('vault_distribute: pnl as a decimal string, vault_id as a number', async () => {
    const { buildNativeVaultDistributeAction } = await import(
      '../src/native/actions.js'
    );
    expect(buildNativeVaultDistributeAction({ vault_id: 42, pnl: '1000.5' })).toBe(
      '{"type":"vault_distribute","params":{"vault_id":42,"pnl":"1000.5"}}',
    );
  });

  it('cross_chain_send: wrapper key `msg`, 32-byte recipient array, numeric amount', async () => {
    const { buildNativeCrossChainSendAction } = await import(
      '../src/native/actions.js'
    );
    const recipient = '[' + new Array(32).fill(7).join(',') + ']';
    expect(
      buildNativeCrossChainSendAction({
        dst_chain_id: 8453,
        recipient: new Uint8Array(32).fill(7),
        token: 1,
        amount: 1000000n,
        nonce: 7,
      }),
    ).toBe(
      `{"type":"cross_chain_send","msg":{"dst_chain_id":8453,"recipient":${recipient},"token":1,"amount":1000000,"nonce":7}}`,
    );
  });

  it('cross_chain_send: rejects a non-32-byte recipient', async () => {
    const { buildNativeCrossChainSendAction } = await import(
      '../src/native/actions.js'
    );
    expect(() =>
      buildNativeCrossChainSendAction({
        dst_chain_id: 1,
        recipient: new Uint8Array(20),
        token: 1,
        amount: 1n,
        nonce: 1,
      }),
    ).toThrow();
  });

});

describe.skipIf(!wasmBuilt)('real native write-action sign → recover', () => {
  it('update_leverage round-trips to the signer (sender-authorized)', async () => {
    const { buildNativeUpdateLeverageAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x42);
    const expected = await signerAddress(privKey);
    const actionJson = buildNativeUpdateLeverageAction({
      asset: 1,
      leverage: 10,
      is_isolated: false,
    });
    const signed = await signNativeAction(privKey, actionJson, 1n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('create_vault round-trips to the signer (the leader)', async () => {
    const { buildNativeCreateVaultAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x55);
    const expected = await signerAddress(privKey);
    const actionJson = buildNativeCreateVaultAction({
      name: 'mlp',
      lock_period_secs: 604800,
    });
    const signed = await signNativeAction(privKey, actionJson, 2n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });

});

// ── W1 microstructure convenience methods route through the typed path ──
//
// The legacy `rfqRequest` / `rfqAccept` / `fbaSubmit` / `encryptedOrderSubmit` /
// `pmUnenroll` methods emitted the pre-W1 OPAQUE sender-authorized shape that
// the typed-only `/exchange` REJECTS. They now sign the W1 typed structs via
// `submitTyped`. The contract: each convenience method's signed `/exchange` body
// is BYTE-IDENTICAL to the generic `submitTyped(<tag>, payload)` path for the
// same input (so the digest can never diverge), carries `sig_scheme:"typed"`,
// and never re-emits the old opaque wrapper keys (`rfq`/`accept`/`submit`/
// `encrypted`). The typed digests themselves are pinned in `typed_w1.test.ts`.
describe.skipIf(!wasmBuilt)(
  'W1 microstructure convenience methods == generic typed path',
  () => {
    const PRIV = new Uint8Array(32).fill(0x3c);
    let bodies: string[] = [];
    let savedFetch: typeof globalThis.fetch;

    beforeEach(() => {
      bodies = [];
      savedFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async (_url: unknown, init: { body?: unknown } = {}) => {
          bodies.push(String(init.body ?? ''));
          return { ok: true, status: 200, text: async () => '{}' } as Response;
        },
      ) as unknown as typeof globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
    });

    async function bodyOf(call: () => Promise<unknown>): Promise<string> {
      bodies = [];
      await call();
      expect(bodies.length).toBe(1);
      const body = bodies[0];
      if (body === undefined) throw new Error('no request body captured');
      return body;
    }

    async function client() {
      const { Client } = await import('../src/client.js');
      return new Client({ baseUrl: 'http://localhost:0', privateKey: PRIV });
    }

    // Each row: convenience invocation + the equivalent generic typed call +
    // the old opaque wrapper key that must NOT reappear.
    const CASES: ReadonlyArray<{
      readonly name: string;
      readonly tag: string;
      readonly payload: Record<string, unknown>;
      readonly conv: (c: Awaited<ReturnType<typeof client>>, n: bigint) => Promise<unknown>;
      readonly opaqueKey: string;
    }> = [
      {
        name: 'rfqRequest',
        tag: 'rfq_request',
        payload: {
          market: 7,
          side: 'Bid',
          size: 1000n,
          limit_px: 42_000n,
          expiry_ms: 1_700_000_000_000,
          stp_group: 3,
        },
        conv: (c, n) =>
          c.rfqRequest(
            {
              market: 7,
              side: 'Bid',
              size: 1000n,
              limit_px: 42_000n,
              expiry_ms: 1_700_000_000_000,
              stp_group: 3,
            },
            { nonce: n },
          ),
        opaqueKey: '"rfq":',
      },
      {
        name: 'rfqAccept',
        tag: 'rfq_accept',
        payload: { rfq_id: 99, quote_idx: 1, size: 500n },
        conv: (c, n) => c.rfqAccept({ rfq_id: 99, quote_idx: 1, size: 500n }, { nonce: n }),
        opaqueKey: '"accept":',
      },
      {
        name: 'fbaSubmit',
        tag: 'fba_submit',
        payload: { market: 5, side: 'Ask', size: 250n, price: 30_000n, stp_group: 9 },
        conv: (c, n) =>
          c.fbaSubmit(
            { market: 5, side: 'Ask', size: 250n, price: 30_000n, stp_group: 9 },
            { nonce: n },
          ),
        opaqueKey: '"submit":',
      },
      {
        name: 'encryptedOrderSubmit',
        tag: 'encrypted_order_submit',
        payload: {
          ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
          commitment: new Uint8Array(32).fill(7),
          threshold: 2,
          target_block: 1000,
          reveal_deadline_ms: 1_700_000_000_000,
        },
        conv: (c, n) =>
          c.encryptedOrderSubmit(
            {
              ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
              commitment: new Uint8Array(32).fill(7),
              threshold: 2,
              target_block: 1000,
              reveal_deadline_ms: 1_700_000_000_000,
            },
            { nonce: n },
          ),
        opaqueKey: '"encrypted":',
      },
    ];

    for (const tc of CASES) {
      it(`${tc.name} body matches submitTyped(${tc.tag}) byte-for-byte`, async () => {
        const c = await client();
        const conv = await bodyOf(() => tc.conv(c, 7n));
        const generic = await bodyOf(() => c.submitTyped(tc.tag, tc.payload, { nonce: 7n }));
        expect(conv).toBe(generic);
        // Typed scheme + canonical tag, never the old opaque wrapper.
        const parsed = JSON.parse(conv) as {
          sig_scheme?: string;
          action: { type: string; params?: unknown };
        };
        expect(parsed.sig_scheme).toBeUndefined();
        expect(parsed.action.type).toBe(tc.tag);
        expect(parsed.action.params).toBeTypeOf('object');
        expect(conv).not.toContain(tc.opaqueKey);
      });
    }

    it('pmUnenroll signs the paramless typed alias (== submitTyped(pm_unenroll))', async () => {
      const c = await client();
      const conv = await bodyOf(() => c.pmUnenroll({ nonce: 4n }));
      const generic = await bodyOf(() => c.submitTyped('pm_unenroll', {}, { nonce: 4n }));
      expect(conv).toBe(generic);
      const parsed = JSON.parse(conv) as {
        sig_scheme?: string;
        action: { type: string; params?: unknown };
      };
      expect(parsed.sig_scheme).toBeUndefined();
      expect(parsed.action).toEqual({ type: 'pm_unenroll' });
      // NOT the legacy opaque user_portfolio_margin envelope.
      expect(conv).not.toContain('user_portfolio_margin');
    });
  },
);

// ── O8: a Market order is take-only — the SDK forces tif="ioc" ──
// The node lowers a Market kind to a marketable limit; a Market+Gtc/Alo would
// REST the unfilled remainder on the book at the caller's price (the footgun).
// The build boundary coerces Market -> Ioc so the SIGNED bytes can never rest.
describe('O8: Market orders are coerced to IOC', () => {
  const baseMarket = {
    owner: ADDR,
    market: 1,
    side: 'bid' as const,
    kind: 'market' as const,
    size: 1000,
    limit_px: 0,
    stp_mode: 'cancel_oldest' as const,
    reduce_only: false,
  };

  function tifInActionJson(json: string): string {
    const m = /"tif":"([^"]+)"/.exec(json);
    if (m === null) throw new Error('no tif in action JSON');
    return m[1];
  }

  it('submit_order: Market + Gtc -> tif:"ioc" in the action JSON', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    const json = buildNativeOrderAction({ ...baseMarket, tif: 'gtc' });
    expect(tifInActionJson(json)).toBe('ioc');
    expect(json).toContain('"kind":"market"');
  });

  it('submit_order: Market + Alo -> tif:"ioc"', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    expect(
      tifInActionJson(buildNativeOrderAction({ ...baseMarket, tif: 'alo' })),
    ).toBe('ioc');
  });

  it('submit_order: Market + Ioc stays "ioc"', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    expect(
      tifInActionJson(buildNativeOrderAction({ ...baseMarket, tif: 'ioc' })),
    ).toBe('ioc');
  });

  it('submit_order: Limit tif is UNTOUCHED', async () => {
    const { buildNativeOrderAction } = await import('../src/native/actions.js');
    for (const tif of ['gtc', 'ioc', 'alo'] as const) {
      const json = buildNativeOrderAction({
        ...baseMarket,
        kind: 'limit',
        limit_px: 5_000_000_000,
        tif,
      });
      expect(tifInActionJson(json)).toBe(tif);
    }
  });

  it('batch_order: each Market leg -> ioc, Limit leg untouched', async () => {
    const { buildNativeBatchOrderAction } = await import('../src/native/actions.js');
    const json = buildNativeBatchOrderAction({
      orders: [
        { ...baseMarket, tif: 'gtc' },
        { ...baseMarket, kind: 'limit', limit_px: 5_000_000_000, tif: 'gtc' },
        { ...baseMarket, tif: 'alo' },
      ],
    });
    const tifs = [...json.matchAll(/"tif":"([^"]+)"/g)].map((m) => m[1]);
    expect(tifs).toEqual(['ioc', 'gtc', 'ioc']);
  });

  it('coerceMarketTif returns a copy and never mutates its input', async () => {
    const { coerceMarketTif } = await import('../src/native/digest.js');
    const original: NativeOrder = { ...baseMarket, tif: 'gtc' };
    const coerced = coerceMarketTif(original);
    expect(original.tif).toBe('gtc'); // input untouched
    expect(coerced.tif).toBe('ioc'); // coerced copy
    expect(coerceMarketTif({ ...baseMarket, kind: 'limit', tif: 'gtc' }).tif).toBe(
      'gtc',
    ); // limit untouched
  });

  // The coercion MUST happen BEFORE the EIP-712 digest, so the SIGNED bytes
  // carry "ioc" (the node verifies the signed tif).
  it.skipIf(!wasmBuilt)(
    'typed digest: a Market order signs as IOC regardless of the requested tif',
    async () => {
      const { buildNativeOrderAction } = await import('../src/native/actions.js');
      const { buildTypedOrder, typedOrderDigest } = await import(
        '../src/native/typed_orders.js'
      );
      const nonce = 7n;

      const digestFor = async (order: NativeOrder): Promise<string> => {
        const built = await buildTypedOrder(
          'submit_order',
          { order },
          buildNativeOrderAction(order),
          nonce,
          KAT_CHAIN_ID,
        );
        return toHex(await typedOrderDigest(built));
      };

      // Coerced Market+Gtc signs identically to an explicit Market+Ioc.
      expect(await digestFor({ ...baseMarket, tif: 'gtc' })).toBe(
        await digestFor({ ...baseMarket, tif: 'ioc' }),
      );

      // tif is genuinely part of the signed bytes: a Limit's digest moves with
      // it, so coercing Market -> Ioc really changes what gets signed.
      const limitBase = { ...baseMarket, kind: 'limit' as const, limit_px: 5_000_000_000 };
      expect(await digestFor({ ...limitBase, tif: 'gtc' })).not.toBe(
        await digestFor({ ...limitBase, tif: 'ioc' }),
      );
    },
  );
});
