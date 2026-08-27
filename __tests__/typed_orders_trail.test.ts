// Trailing-stop signing — cross-impl known-answer vectors.
//
// `trigger.trail_px` moves WHERE a position closes, so it is a CONTROL field and
// the EIP-712 digest binds it. The node folds it into a longer type string on
// PRESENCE, not value: `,uint64 trailPx` for `submit_order`, `,bytes32 trailPxs`
// for `batch_order`. An order with no trail keeps the frozen digest byte-for-byte.
//
// The four digests below are pasted verbatim from the node's own KAT emitter
// (chain 114514 / "Testnet", domain `metaflux_v1`). If one drifts, this SDK is
// signing something the chain will not verify.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeOrderAction } from '../src/native/actions.js';
import type { BatchOrder, NativeOrder } from '../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBuilt = existsSync(resolve(__dirname, '..', 'pkg', 'metaflux_client_wasm.js'));

const CHAIN_ID = 114514;
const OWNER = '0x1111111111111111111111111111111111111111';
const BUILDER = '0x2222222222222222222222222222222222222222';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// The node KAT's plain leg — no trigger, so no trail.
function plainLeg(): NativeOrder {
  return {
    owner: OWNER,
    market: 1,
    side: 'bid',
    kind: 'limit',
    size: 100,
    limit_px: 6_800_000_000_000,
    tif: 'gtc',
    stp_mode: 'cancel_newest',
    reduce_only: false,
  };
}

/// The node KAT's rich protective leg. `trail` omitted => the trigger carries no
/// `trail_px` key at all (absent, not zero).
function richLeg(trail?: number): NativeOrder {
  return {
    owner: OWNER,
    market: 7,
    side: 'ask',
    kind: 'take_profit',
    size: 500,
    limit_px: 0,
    tif: 'alo',
    stp_mode: 'cancel_oldest',
    reduce_only: true,
    cloid: '0xabababababababababababababababab',
    builder: { fee: 25, user: BUILDER },
    position_side: 'short',
    trigger: {
      trigger_px: 4200,
      is_market: true,
      tpsl: 'tp',
      ...(trail === undefined ? {} : { trail_px: trail }),
    },
  };
}

function mixedBatch(trail?: number): BatchOrder {
  return { owner: OWNER, orders: [plainLeg(), richLeg(trail)], grouping: 'normalTpsl' };
}

const SUBMIT_TRAIL_TYPE =
  'MetaFluxTransaction:SubmitOrder(string metafluxChain,uint32 market,string side,string kind,uint64 size,uint64 limitPx,string tif,string stpMode,bool reduceOnly,string cloid,uint16 builderFee,address builderUser,string positionSide,uint64 triggerPx,bool triggerIsMarket,string triggerTpsl,uint64 trailPx,uint64 nonce)';
const BATCH_OWNER_TRAIL_TYPE =
  'MetaFluxTransaction:BatchOrder(string metafluxChain,address owner,bytes32 orders,string grouping,bytes32 trailPxs,uint64 nonce)';
const BATCH_OWNER_TYPE =
  'MetaFluxTransaction:BatchOrder(string metafluxChain,address owner,bytes32 orders,string grouping,uint64 nonce)';

// Node KAT digests, chain 114514, nonce 1.
const KAT_TRAILING_SINGLE =
  'f78212e9ab8ad38ad455552cd9343a7a6637a8d331f23528fe7ae84713a20b64';
const KAT_MIXED_BATCH_WITH_OWNER =
  'df6da2a4e1c3cabd1852bfa1aa05495a839d3787f1a01e2df18c199b53453b88';
const KAT_NO_TRAIL_CONTROL =
  'ef21c04ccb568652ab2d8950dffd1bd289acaafde846199f74a8ba72e0f5dad8';
const KAT_TRAILING_SINGLE_WITH_EXPIRY =
  '3f4d7fd0d3fb293e604fe6e5c4fc52e7b76830eaa39f8dc5d4d26b34372d5d92';

describe.skipIf(!wasmBuilt)('trailing-stop typed signing', () => {
  it('reproduces the four node KAT digests byte-for-byte', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const digest = async (
      actionType: string,
      payload: Parameters<typeof buildTypedOrder>[1],
      expiresAfter = 0n,
    ): Promise<string> =>
      toHex(
        await typedOrderDigest(
          await buildTypedOrder(
            actionType,
            payload,
            '',
            1n,
            CHAIN_ID,
            undefined,
            expiresAfter,
          ),
        ),
      );

    expect(await digest('submit_order', { order: richLeg(50_000_000) })).toBe(
      KAT_TRAILING_SINGLE,
    );
    expect(await digest('batch_order', { params: mixedBatch(50_000_000) })).toBe(
      KAT_MIXED_BATCH_WITH_OWNER,
    );
    expect(await digest('batch_order', { params: mixedBatch() })).toBe(
      KAT_NO_TRAIL_CONTROL,
    );
    expect(
      await digest('submit_order', { order: richLeg(50_000_000) }, 1_900_000_000_000n),
    ).toBe(KAT_TRAILING_SINGLE_WITH_EXPIRY);
  });

  it('selects the trailing type string on presence, and only then', async () => {
    const { buildTypedOrder, encodeOrderType } = await import(
      '../src/native/typed_orders.js'
    );
    expect(encodeOrderType('submit_order', false, true)).toBe(SUBMIT_TRAIL_TYPE);
    expect(encodeOrderType('batch_order', true, true)).toBe(BATCH_OWNER_TRAIL_TYPE);
    expect(encodeOrderType('batch_order', true, false)).toBe(BATCH_OWNER_TYPE);
    // An action with no trailing form falls back to its frozen string.
    expect(encodeOrderType('cancel_order', false, true)).toBe(
      encodeOrderType('cancel_order'),
    );

    const trailed = await buildTypedOrder(
      'submit_order',
      { order: richLeg(50_000_000) },
      '',
      1n,
      CHAIN_ID,
    );
    expect(trailed.withTrail).toBe(true);
    const plain = await buildTypedOrder(
      'submit_order',
      { order: richLeg() },
      '',
      1n,
      CHAIN_ID,
    );
    expect(plain.withTrail).toBe(false);
    // One extra word, and only one.
    expect(trailed.words.length).toBe(plain.words.length + 1);
  });

  it('an explicit zero trail is a DIFFERENT digest from an absent one', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const hex = async (o: NativeOrder): Promise<string> =>
      toHex(
        await typedOrderDigest(
          await buildTypedOrder('submit_order', { order: o }, '', 1n, CHAIN_ID),
        ),
      );
    expect(await hex(richLeg(0))).not.toBe(await hex(richLeg()));
    // The absent form is the frozen one.
    expect(await hex(richLeg())).not.toBe(KAT_TRAILING_SINGLE);
  });

  it('permuting WHICH batch leg trails moves the digest', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const hex = async (params: BatchOrder): Promise<string> =>
      toHex(
        await typedOrderDigest(
          await buildTypedOrder('batch_order', { params }, '', 1n, CHAIN_ID),
        ),
      );
    const trailOnRich = mixedBatch(50_000_000);
    const trailOnPlain: BatchOrder = {
      owner: OWNER,
      orders: [
        {
          ...plainLeg(),
          trigger: { trigger_px: 4200, is_market: true, tpsl: 'tp', trail_px: 50_000_000 },
        },
        richLeg(),
      ],
      grouping: 'normalTpsl',
    };
    expect(await hex(trailOnPlain)).not.toBe(await hex(trailOnRich));
  });

  it('the wire JSON carries trail_px last inside trigger, and omits it when absent', () => {
    expect(buildNativeOrderAction(richLeg(50_000_000))).toContain(
      '"trigger":{"trigger_px":4200,"is_market":true,"tpsl":"tp","trail_px":50000000}',
    );
    expect(buildNativeOrderAction(richLeg())).toContain(
      '"trigger":{"trigger_px":4200,"is_market":true,"tpsl":"tp"}',
    );
  });
});
