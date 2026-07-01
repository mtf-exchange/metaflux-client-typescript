// EIP-712 typed signing for the trading set — cross-impl known-answer vectors.
//
// Pins the TS trading-action typed digest to the SAME value the server commits
// to for all 12 trading actions (chain id 114514 / "Testnet"). The inputs mirror
// the server's `sample_order()` / `sample_modify()` / `all_actions()` fixtures;
// the digest pins are the frozen cross-language contract. If a digest drifts, the
// TS SDK is signing something the server will not verify.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  NativeOrder,
  NativeCancel,
  NativeSpotOrder,
  NativeSpotCancel,
  Modify,
  BatchModify,
  ScheduleCancel,
  TwapOrder,
  TwapCancel,
  BatchOrder,
  BatchCancel,
  CancelByCloid,
} from '../src/types/index.js';
import type { TypedOrderPayload } from '../src/native/typed_orders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

if (!wasmBuilt) {
  console.warn(
    '[typed_orders.test.ts] pkg/ not found — skipping WASM tests. ' +
      'Run `npm run build:wasm` to enable.',
  );
}

const CHAIN_ID = 114514;
const OWNER = '0x00000000000000000000000000000000000000aa';

/// Expand a single byte into a `0x` + 40-hex address (server fixture `addr(b)`).
function addr(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ---- server fixtures (mirror the node's frozen typed-action KAT vectors) ----

/// The server's `sample_order()`: a populated perp order (builder + long leg).
/// `owner` is SDK-only (not part of the typed digest); it is set so the wire
/// JSON is well-formed for the owner-checked path.
function sampleOrder(): NativeOrder {
  return {
    owner: OWNER,
    market: 1,
    side: 'bid',
    kind: 'limit',
    size: 1_000,
    limit_px: 5_000_000_000,
    tif: 'gtc',
    stp_mode: 'cancel_oldest',
    reduce_only: false,
    cloid: '0xabababababababababababababababab',
    builder: { fee: 5, user: addr(0xbd) },
    position_side: 'long',
  };
}

/// The server's `sample_modify()`.
function sampleModify(): Modify {
  return { market: 3, oid: 42, new_px: 1_234, new_size: 9 };
}

/// One trading action vector: type tag, the typed payload, nonce, and the
/// server's frozen digest pin (chain 114514).
interface Vector {
  actionType: string;
  payload: TypedOrderPayload;
  nonce: bigint;
  digest: string;
}

const VECTORS: Vector[] = [
  {
    actionType: 'submit_order',
    payload: { order: sampleOrder() },
    nonce: 40n,
    digest: '26e9092cb07147e53fe7c9aa087bcb03a371c2bc5c03e27cf8920ce1f1ea6385',
  },
  {
    actionType: 'cancel_order',
    payload: { cancel: { owner: OWNER, market: 1, oid: 99 } as NativeCancel },
    nonce: 41n,
    digest: 'bf61ce82e82ce6ed077defb6fc31eb7594889117865f9c51cd561bcb1aa2f246',
  },
  {
    actionType: 'spot_order',
    payload: {
      order: {
        pair: 200,
        side: 'bid',
        size: 10,
        limit_px: 200_000_000,
        tif: 'ioc',
        stp_mode: 'cancel_oldest',
      } as NativeSpotOrder,
    },
    nonce: 42n,
    digest: 'c5cb02b8b11fb3caae7640558321d8c2509e06639a76dbc8423daf7e5b8b264a',
  },
  {
    actionType: 'spot_cancel',
    payload: { cancel: { pair: 200, oid: 7 } as NativeSpotCancel },
    nonce: 43n,
    digest: '9afee65cc899ae56e71a676da3035c133e1a135e2dc2e2e897128258aca1751f',
  },
  {
    actionType: 'cancel_by_cloid',
    payload: {
      params: {
        asset: 7,
        cloid: '0xabababababababababababababababab',
      } as CancelByCloid,
    },
    nonce: 44n,
    digest: '7aed7d1162b6e804a7ffa8d266c0c6e9fe33ed4278fb6746801e855a985dcec1',
  },
  {
    actionType: 'modify',
    payload: { params: sampleModify() },
    nonce: 45n,
    digest: '587bcf3581a9efed1a634473e2db81cd49ad581a5d2c8cd8a817ee17988acfe7',
  },
  {
    actionType: 'batch_modify',
    payload: {
      params: { modifications: [sampleModify(), sampleModify()] } as BatchModify,
    },
    nonce: 46n,
    digest: 'fb91c4a53e806a1c6dd06e1e2ef892f8f99707079431a58476d8ce438195e04c',
  },
  {
    actionType: 'schedule_cancel',
    payload: { params: { cancel_at_block: 999 } as ScheduleCancel },
    nonce: 47n,
    digest: 'f1c7b4c2af0753679d7530ed7d62016d5372543ab641e469d8ae0e7fc6c46a43',
  },
  {
    actionType: 'twap_order',
    payload: {
      params: {
        market: 4,
        side: 'ask',
        total_size: 1_000,
        slice_count: 10,
        delay_ms: 500,
        reduce_only: true,
      } as TwapOrder,
    },
    nonce: 48n,
    digest: '057ba67d71d21a2b32ef060cdaf0eadc1b736524209eb38b285d4be712625714',
  },
  {
    actionType: 'twap_cancel',
    payload: { params: { twap_id: 17 } as TwapCancel },
    nonce: 49n,
    digest: '12a8d7014ce66306a76260f8463f310af3a00568bd4a882fdd9033b63aec364f',
  },
  {
    actionType: 'batch_order',
    payload: {
      params: { orders: [sampleOrder()], grouping: 'na' } as BatchOrder,
    },
    nonce: 50n,
    digest: 'ecd87cbb39934732153edc401cb79019e873c2ee819f0f36298b563f7845edb8',
  },
  {
    actionType: 'batch_cancel',
    payload: {
      params: {
        cancels: [
          { owner: OWNER, market: 1, oid: 10 },
          { owner: OWNER, market: 2, oid: 11 },
        ],
      } as BatchCancel,
    },
    nonce: 51n,
    digest: '61bb7f44a4d1375eeebaab7421a213587e75bc1e503cedbc09387e6a76e3affe',
  },
];

describe.skipIf(!wasmBuilt)('EIP-712 typed-action signing — trading set', () => {
  it('reproduces all 12 server KAT digests byte-for-byte (chain 114514)', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    expect(VECTORS.length).toBe(12);
    for (const v of VECTORS) {
      const built = await buildTypedOrder(v.actionType, v.payload, '', v.nonce, CHAIN_ID);
      const digest = await typedOrderDigest(built);
      expect(toHex(digest), `digest mismatch for ${v.actionType}`).toBe(v.digest);
    }
  });

  it('submit_order matches the server pin individually', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const built = await buildTypedOrder('submit_order', { order: sampleOrder() }, '', 40n, CHAIN_ID);
    expect(toHex(await typedOrderDigest(built))).toBe(
      '26e9092cb07147e53fe7c9aa087bcb03a371c2bc5c03e27cf8920ce1f1ea6385',
    );
  });

  it('batch_order T[] hashing matches the server pin', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const built = await buildTypedOrder(
      'batch_order',
      { params: { orders: [sampleOrder()], grouping: 'na' } },
      '',
      50n,
      CHAIN_ID,
    );
    expect(toHex(await typedOrderDigest(built))).toBe(
      'ecd87cbb39934732153edc401cb79019e873c2ee819f0f36298b563f7845edb8',
    );
  });

  it('owner-carrying batch_order byte-matches the Rust SDK KAT (owner word at pos 2)', async () => {
    // Cross-impl pin: mirrors the Rust SDK's `batch_order_kat`
    // (owner 0x1111..11, [plain_order, rich_order], grouping normalTpsl, chain
    // 114514, nonce 1). The params-level `owner` selects the owner-carrying type
    // string and inserts the owner address word right after metafluxChain.
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    // Rust `plain_order()`.
    const plainOrder: NativeOrder = {
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
    // Rust `rich_order()`.
    const richOrder: NativeOrder = {
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
      builder: { fee: 25, user: addr(0x22) },
      position_side: 'short',
      trigger: { trigger_px: 4_200, is_market: true, tpsl: 'tp' },
    };
    const built = await buildTypedOrder(
      'batch_order',
      {
        params: {
          owner: addr(0x11),
          orders: [plainOrder, richOrder],
          grouping: 'normalTpsl',
        },
      },
      '',
      1n,
      CHAIN_ID,
    );
    expect(built.withOwner).toBe(true);
    expect(toHex(await typedOrderDigest(built))).toBe(
      'ef21c04ccb568652ab2d8950dffd1bd289acaafde846199f74a8ba72e0f5dad8',
    );
  });

  it('owner-less batch_order digest is unchanged (back-compat)', async () => {
    // Adding the optional owner must NOT change the owner-less digest — existing
    // signatures still verify. Same inputs as the server pin above, no owner.
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const built = await buildTypedOrder(
      'batch_order',
      { params: { orders: [sampleOrder()], grouping: 'na' } },
      '',
      50n,
      CHAIN_ID,
    );
    expect(built.withOwner).toBe(false);
    expect(toHex(await typedOrderDigest(built))).toBe(
      'ecd87cbb39934732153edc401cb79019e873c2ee819f0f36298b563f7845edb8',
    );
  });

  it('encodeOrderType selects the owner-carrying batch_order type only with withOwner', async () => {
    const { encodeOrderType } = await import('../src/native/typed_orders.js');
    expect(encodeOrderType('batch_order')).toBe(
      'MetaFluxTransaction:BatchOrder(string metafluxChain,bytes32 orders,string grouping,uint64 nonce)',
    );
    expect(encodeOrderType('batch_order', true)).toBe(
      'MetaFluxTransaction:BatchOrder(string metafluxChain,address owner,bytes32 orders,string grouping,uint64 nonce)',
    );
  });

  it('encodeType strings match the frozen server contract (field order)', async () => {
    const { encodeOrderType } = await import('../src/native/typed_orders.js');
    expect(encodeOrderType('submit_order')).toBe(
      'MetaFluxTransaction:SubmitOrder(string metafluxChain,uint32 market,string side,string kind,uint64 size,uint64 limitPx,string tif,string stpMode,bool reduceOnly,string cloid,uint16 builderFee,address builderUser,string positionSide,uint64 triggerPx,bool triggerIsMarket,string triggerTpsl,uint64 nonce)',
    );
    expect(encodeOrderType('cancel_order')).toBe(
      'MetaFluxTransaction:CancelOrder(string metafluxChain,uint32 market,uint64 oid,uint64 nonce)',
    );
    expect(encodeOrderType('modify')).toBe(
      'MetaFluxTransaction:Modify(string metafluxChain,uint32 market,uint64 oid,bool hasNewPx,uint64 newPx,bool hasNewSize,uint64 newSize,string cloid,bool alwaysPlace,uint64 nonce)',
    );
    expect(encodeOrderType('batch_order')).toBe(
      'MetaFluxTransaction:BatchOrder(string metafluxChain,bytes32 orders,string grouping,uint64 nonce)',
    );
  });

  it('isTypedOrderAction / TYPED_ORDER_ACTION_TYPES cover exactly the 12 trading actions', async () => {
    const { isTypedOrderAction, TYPED_ORDER_ACTION_TYPES } = await import(
      '../src/native/typed_orders.js'
    );
    expect(TYPED_ORDER_ACTION_TYPES.length).toBe(12);
    expect(isTypedOrderAction('submit_order')).toBe(true);
    expect(isTypedOrderAction('cancel_order')).toBe(true);
    expect(isTypedOrderAction('batch_cancel')).toBe(true);
    // Account-set + unmapped actions are NOT trading typed actions.
    expect(isTypedOrderAction('approve_agent')).toBe(false);
    expect(isTypedOrderAction('cancel_all_orders')).toBe(false);
  });

  it('a submit_order with a builder + trigger block flattens into the typed digest', async () => {
    // Field-sensitivity: a trigger block changes the digest vs the trigger-less
    // base, proving the trigger fields are bound (not silently dropped).
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const base: NativeOrder = {
      owner: OWNER,
      market: 7,
      side: 'ask',
      kind: 'take_profit',
      size: 500,
      limit_px: 0,
      tif: 'ioc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
    };
    const withTrigger: NativeOrder = {
      ...base,
      trigger: { trigger_px: 4_200, is_market: true, tpsl: 'tp' },
    };
    const d0 = toHex(
      await typedOrderDigest(await buildTypedOrder('submit_order', { order: base }, '', 1n, CHAIN_ID)),
    );
    const d1 = toHex(
      await typedOrderDigest(
        await buildTypedOrder('submit_order', { order: withTrigger }, '', 1n, CHAIN_ID),
      ),
    );
    expect(d0).not.toBe(d1);
  });

  it('typed trading request body omits the vestigial sig_scheme, carries the verbatim action', async () => {
    const { signTypedOrder, typedOrderRequestBody } = await import(
      '../src/native/typed_orders.js'
    );
    const privKey = new Uint8Array(32).fill(0x37);
    const actionJson =
      '{"type":"twap_cancel","params":{"twap_id":17}}';
    const signed = await signTypedOrder(
      privKey,
      'twap_cancel',
      { params: { twap_id: 17 } },
      actionJson,
      49n,
      CHAIN_ID,
    );
    const body = typedOrderRequestBody(signed);
    expect(body.includes(`"action":${actionJson}`)).toBe(true);
    expect(body.includes('"sig_scheme"')).toBe(false);
    expect(body.includes('"nonce":49')).toBe(true);
    const parsed = JSON.parse(body) as { sig_scheme?: string; nonce: number };
    expect(parsed.sig_scheme).toBeUndefined();
    expect(parsed.nonce).toBe(49);
  });

  it('sign → recover round-trips to the signing address', async () => {
    const { signTypedOrder, recoverTypedOrderSigner } = await import(
      '../src/native/typed_orders.js'
    );
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wallet/wasm.js');

    const privKey = new Uint8Array(32).fill(0x37);
    const probe = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probe);
    const probePub = await recoverPubkey(probeSig, probe);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const order: NativeOrder = { ...sampleOrder(), owner };
    const actionJson = '{"type":"submit_order","order":{}}';
    const signed = await signTypedOrder(
      privKey,
      'submit_order',
      { order },
      actionJson,
      40n,
      CHAIN_ID,
    );
    expect(signed.signature.startsWith('0x')).toBe(true);
    expect(signed.signature.length).toBe(2 + 130); // 0x + 65 bytes
    const recovered = await recoverTypedOrderSigner(signed, 'submit_order', { order }, CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('a cloid-only cancel has no typed form (fails loud)', async () => {
    const { buildTypedOrder } = await import('../src/native/typed_orders.js');
    await expect(
      buildTypedOrder(
        'cancel_order',
        { cancel: { owner: OWNER, market: 3, cloid: '0xabababababababababababababababab' } },
        '',
        1n,
        CHAIN_ID,
      ),
    ).rejects.toThrow();
  });
});

// ── agent-resolved `owner` (operator / vault trading) ────────────────────────
//
// Cross-impl KATs for the seven owner-supporting trading actions. Each pins the
// SAME digest the Rust SDK + the node commit to (owner 0xbb..bb, chain 114514,
// nonce 1 — the Rust SDK's `*_WITH_OWNER` fixtures, so both SDKs pin identical
// vectors). For each: (1) the SDK's selected encodeType bytes equal the node's
// `*_WITH_OWNER_TYPE` literal (copied verbatim from the node's typed-order
// signing contract); (2) the owner-present digest matches the pinned vector; (3)
// it DIFFERS from the owner-less digest (the owner is cryptographically bound);
// and (4) the owner-LESS digest reproduces the pre-owner KAT — owner-absent is
// byte-identical to today. `batch_order` (owner inside its `BatchOrder.owner`
// struct) is covered separately above.

const OWNER_BIND = addr(0xbb);
const RUST_CLOID = '0xabababababababababababababababab';

/// The Rust SDK's `modify()` fixture (distinct from `sampleModify()` above).
function rustModify(): Modify {
  return { market: 1, oid: 1234, new_px: 6_900_000_000_000, new_size: 200 };
}

interface OwnerVector {
  actionType: string;
  payload: TypedOrderPayload;
  /// The node's `*_WITH_OWNER_TYPE` literal (verbatim).
  ownerType: string;
  /// Owner-present digest pin (owner 0xbb..bb, chain 114514, nonce 1).
  ownerDigest: string;
  /// Owner-less digest pin (= the pre-owner KAT — back-compat).
  plainDigest: string;
}

const OWNER_VECTORS: OwnerVector[] = [
  {
    actionType: 'modify',
    payload: { params: rustModify() },
    ownerType:
      'MetaFluxTransaction:Modify(string metafluxChain,address owner,uint32 market,uint64 oid,bool hasNewPx,uint64 newPx,bool hasNewSize,uint64 newSize,string cloid,bool alwaysPlace,uint64 nonce)',
    ownerDigest: '6c9f289d2785cd12fdad8f5933623cfcde275ba17f83d196dc667930577607a0',
    plainDigest: '2ef6437095dd5d2a71265b78abe9ef5ef5db97d385d27e768225f326eff98d19',
  },
  {
    actionType: 'cancel_by_cloid',
    payload: { params: { asset: 1, cloid: RUST_CLOID } as CancelByCloid },
    ownerType:
      'MetaFluxTransaction:CancelByCloid(string metafluxChain,address owner,uint32 asset,string cloid,uint64 nonce)',
    ownerDigest: '607915958cc50aa3688744ce281f477a2a13ed74f7b49dd3b24492c2ebd10d40',
    plainDigest: '575fdab951085e30a1f260cae0a8fc2dfdc416247a3e4f5707a0b09d25a2fc24',
  },
  {
    actionType: 'spot_order',
    payload: {
      order: {
        pair: 3,
        side: 'bid',
        size: 50,
        limit_px: 100_000_000,
        tif: 'ioc',
        stp_mode: 'cancel_oldest',
        cloid: RUST_CLOID,
      } as NativeSpotOrder,
    },
    ownerType:
      'MetaFluxTransaction:SpotOrder(string metafluxChain,address owner,uint32 pair,string side,uint64 size,uint64 limitPx,string tif,string stpMode,string cloid,uint64 nonce)',
    ownerDigest: '974960f541953bf10ad3677c41ebfa9d8cbeb90868f74ccdf44590327e7163fc',
    plainDigest: '981902cfbf00fc9c9bb26acdebfe356cd0e2b8da69199ed9b8ae2a316cf1cb34',
  },
  {
    actionType: 'spot_cancel',
    payload: { cancel: { pair: 3, oid: 99 } as NativeSpotCancel },
    ownerType:
      'MetaFluxTransaction:SpotCancel(string metafluxChain,address owner,uint32 pair,uint64 oid,uint64 nonce)',
    ownerDigest: '378a4b73e59a10e121c05f47c82f599147f66faf9ff6510d489d7baedfabb8f5',
    plainDigest: '5f794c0c7a2c1b473efd5e86a4386385ce4696ad2cdc8d849eb9b30745c5f7fc',
  },
  {
    actionType: 'batch_modify',
    payload: {
      params: { modifications: [rustModify(), { market: 2, oid: 5678 }] } as BatchModify,
    },
    ownerType:
      'MetaFluxTransaction:BatchModify(string metafluxChain,address owner,bytes32 modifications,uint64 nonce)',
    ownerDigest: 'a38064007bd676e1c7f524138bfd74853861a7e7ca8d971429bf16110ead06da',
    plainDigest: 'c0914a0623f6032bdc85adb0b572fab74d8c5f775bef10455bcebd5454e3dd14',
  },
  {
    actionType: 'batch_cancel',
    payload: {
      params: {
        cancels: [
          { owner: addr(0x11), market: 1, oid: 1234 },
          { owner: addr(0x11), market: 2, oid: 5678 },
        ],
      } as BatchCancel,
    },
    ownerType:
      'MetaFluxTransaction:BatchCancel(string metafluxChain,address owner,bytes32 cancels,uint64 nonce)',
    ownerDigest: '331396c719d6bbf49572ec3366a430b78eb5193d73c5475ccd204c8a6d681aef',
    plainDigest: '46d484036118744ef5996146ec9d35e1a54f550913238564831d5cc33d3af449',
  },
  {
    actionType: 'twap_cancel',
    payload: { params: { twap_id: 42 } as TwapCancel },
    ownerType:
      'MetaFluxTransaction:TwapCancel(string metafluxChain,address owner,uint64 twapId,uint64 nonce)',
    ownerDigest: '2fe790c3e954f69cdd91734c4608c5568bf698a9ef19aa65f40356c3c0b9e3ce',
    plainDigest: '08ebfec844ed708f1085d0251450503f309e0f44c450943227c4cf7e0b3a589f',
  },
];

describe.skipIf(!wasmBuilt)(
  'EIP-712 typed signing — agent-resolved owner (trading set)',
  () => {
    it('owner-supporting actions cover exactly the seven non-batch_order actions', async () => {
      const { supportsOwner } = await import('../src/native/typed_orders.js');
      for (const v of OWNER_VECTORS) expect(supportsOwner(v.actionType)).toBe(true);
      // batch_order carries its owner in `BatchOrder.owner`, NOT the digest-level
      // owner — so it is NOT a digest-level owner-supporting action.
      expect(supportsOwner('batch_order')).toBe(false);
      // Actions with no owner form at all.
      expect(supportsOwner('submit_order')).toBe(false);
      expect(supportsOwner('cancel_order')).toBe(false);
      expect(supportsOwner('schedule_cancel')).toBe(false);
      expect(supportsOwner('twap_order')).toBe(false);
    });

    it('the 7 owner-supporting actions match the Rust SDK + node *_WITH_OWNER vectors', async () => {
      const { buildTypedOrder, typedOrderDigest, encodeOrderType } = await import(
        '../src/native/typed_orders.js'
      );
      for (const v of OWNER_VECTORS) {
        // (1) selected encodeType == node *_WITH_OWNER_TYPE (verbatim).
        expect(encodeOrderType(v.actionType, true), `${v.actionType} owner type`).toBe(
          v.ownerType,
        );
        // (2) owner-present digest == pinned cross-impl vector.
        const owned = await buildTypedOrder(
          v.actionType,
          v.payload,
          '',
          1n,
          CHAIN_ID,
          OWNER_BIND,
        );
        expect(owned.withOwner, `${v.actionType} withOwner`).toBe(true);
        expect(owned.owner, `${v.actionType} owner`).toBe(OWNER_BIND);
        const ownerHex = toHex(await typedOrderDigest(owned));
        expect(ownerHex, `${v.actionType} owner digest`).toBe(v.ownerDigest);
        // (3) differs from owner-less; (4) owner-less == pre-owner KAT.
        const plain = await buildTypedOrder(v.actionType, v.payload, '', 1n, CHAIN_ID);
        expect(plain.withOwner, `${v.actionType} owner-less withOwner`).toBe(false);
        const plainHex = toHex(await typedOrderDigest(plain));
        expect(plainHex, `${v.actionType} owner-less digest`).toBe(v.plainDigest);
        expect(ownerHex, `${v.actionType} owner binds`).not.toBe(plainHex);
      }
    });

    it('owner is ignored for an action with no owner form (submit_order)', async () => {
      const { buildTypedOrder, typedOrderDigest, encodeOrderType } = await import(
        '../src/native/typed_orders.js'
      );
      // The owner-carrying encodeType selector falls back to the base type.
      expect(encodeOrderType('submit_order', true)).toBe(encodeOrderType('submit_order'));
      const order = sampleOrder();
      const owned = await buildTypedOrder(
        'submit_order',
        { order },
        '',
        40n,
        CHAIN_ID,
        OWNER_BIND,
      );
      expect(owned.withOwner).toBe(false);
      expect(owned.owner).toBeUndefined();
      const plain = await buildTypedOrder('submit_order', { order }, '', 40n, CHAIN_ID);
      expect(toHex(await typedOrderDigest(owned))).toBe(
        toHex(await typedOrderDigest(plain)),
      );
    });

    it('sign with a bound owner → recover round-trips to the signer (modify)', async () => {
      const { signTypedOrder, recoverTypedOrderSigner } = await import(
        '../src/native/typed_orders.js'
      );
      const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
        await import('../src/wallet/wasm.js');
      const privKey = new Uint8Array(32).fill(0x5a);
      const probe = await keccak256(new TextEncoder().encode('probe'));
      const probePub = await recoverPubkey(await signSecp256k1(privKey, probe), probe);
      const signer = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;
      // The signer is an approved agent of OWNER_BIND (the vault); the wire JSON
      // carries `params.owner` so the node rebuilds the same WITH_OWNER digest.
      const actionJson = `{"type":"modify","params":{"owner":"${OWNER_BIND}","market":1,"oid":1234}}`;
      const signed = await signTypedOrder(
        privKey,
        'modify',
        { params: rustModify() },
        actionJson,
        1n,
        CHAIN_ID,
        OWNER_BIND,
      );
      const recovered = await recoverTypedOrderSigner(
        signed,
        'modify',
        { params: rustModify() },
        CHAIN_ID,
        OWNER_BIND,
      );
      expect(recovered.toLowerCase()).toBe(signer.toLowerCase());
    });
  },
);
