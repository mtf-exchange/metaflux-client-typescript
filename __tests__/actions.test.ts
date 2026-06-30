// Real-node native write-action builders — JSON-shape pins + a sign/recover
// round-trip. Covers a representative slice of the reconciled /exchange surface
// (vaults, leverage/margin, TWAP, staking, MetaBridge, encrypted, batch). The
// 5 original builders are byte-pinned separately in `native.test.ts`.

import { describe, expect, it } from 'vitest';
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

describe('forward-compat write-action builders (RFQ / FBA / cross-chain / encrypted / vault_distribute)', () => {
  it('vault_distribute: pnl as a decimal string, vault_id as a number', async () => {
    const { buildNativeVaultDistributeAction } = await import(
      '../src/native/actions.js'
    );
    expect(buildNativeVaultDistributeAction({ vault_id: 42, pnl: '1000.5' })).toBe(
      '{"type":"vault_distribute","params":{"vault_id":42,"pnl":"1000.5"}}',
    );
  });

  it('rfq_request: wrapper key `rfq`, PascalCase side, null optional keys present', async () => {
    const { buildNativeRfqRequestAction } = await import('../src/native/actions.js');
    expect(
      buildNativeRfqRequestAction({
        market: 7,
        side: 'Bid',
        size: 1000n,
        limit_px: null,
        expiry_ms: 0,
        stp_group: null,
      }),
    ).toBe(
      '{"type":"rfq_request","rfq":{"market":7,"side":"Bid","size":1000,"limit_px":null,"expiry_ms":0,"stp_group":null}}',
    );
  });

  it('rfq_request: emits present limit_px (i128) + stp_group', async () => {
    const { buildNativeRfqRequestAction } = await import('../src/native/actions.js');
    expect(
      buildNativeRfqRequestAction({
        market: 1,
        side: 'Ask',
        size: 5n,
        limit_px: -3n,
        expiry_ms: 1700000000000,
        stp_group: 9,
      }),
    ).toBe(
      '{"type":"rfq_request","rfq":{"market":1,"side":"Ask","size":5,"limit_px":-3,"expiry_ms":1700000000000,"stp_group":9}}',
    );
  });

  it('rfq_request: rejects a snake_case side token', async () => {
    const { buildNativeRfqRequestAction } = await import('../src/native/actions.js');
    expect(() =>
      buildNativeRfqRequestAction({
        market: 1,
        // @ts-expect-error — snake_case is not a CoreSide.
        side: 'bid',
        size: 1n,
        limit_px: null,
        expiry_ms: 0,
        stp_group: null,
      }),
    ).toThrow();
  });

  it('rfq_accept: wrapper key `accept`', async () => {
    const { buildNativeRfqAcceptAction } = await import('../src/native/actions.js');
    expect(
      buildNativeRfqAcceptAction({ rfq_id: 5, quote_idx: 0, size: 1000n }),
    ).toBe('{"type":"rfq_accept","accept":{"rfq_id":5,"quote_idx":0,"size":1000}}');
  });

  it('fba_submit: wrapper key `submit`, `price` (not limit_px), null stp_group present', async () => {
    const { buildNativeFbaSubmitAction } = await import('../src/native/actions.js');
    expect(
      buildNativeFbaSubmitAction({
        market: 7,
        side: 'Ask',
        size: 1000n,
        price: 5000000000n,
        stp_group: null,
      }),
    ).toBe(
      '{"type":"fba_submit","submit":{"market":7,"side":"Ask","size":1000,"price":5000000000,"stp_group":null}}',
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

  it('encrypted_order_submit: wrapper key `encrypted`, 3 fields only', async () => {
    const { buildNativeEncryptedOrderSubmitAction } = await import(
      '../src/native/actions.js'
    );
    const commitment = '[' + new Array(32).fill(0).join(',') + ']';
    const out = buildNativeEncryptedOrderSubmitAction({
      ciphertext: new Uint8Array([1, 2, 255]),
      commitment: new Uint8Array(32),
      reveal_deadline_ms: 123,
    });
    expect(out).toBe(
      `{"type":"encrypted_order_submit","encrypted":{"ciphertext":[1,2,255],"commitment":${commitment},"reveal_deadline_ms":123}}`,
    );
    // Distinct from submit_encrypted_order: no threshold / target_block keys.
    expect(out).not.toContain('threshold');
    expect(out).not.toContain('target_block');
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

  it('rfq_request (forward-compat) signs over its exact bytes and recovers the signer', async () => {
    const { buildNativeRfqRequestAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x66);
    const expected = await signerAddress(privKey);
    const actionJson = buildNativeRfqRequestAction({
      market: 7,
      side: 'Bid',
      size: 1000n,
      limit_px: null,
      expiry_ms: 0,
      stp_group: null,
    });
    const signed = await signNativeAction(privKey, actionJson, 3n, KAT_CHAIN_ID);
    // The signed envelope carries the EXACT builder bytes (raw, not re-parsed).
    expect(signed.actionJson).toBe(actionJson);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });
});

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
