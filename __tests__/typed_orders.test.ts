// EIP-712 typed signing for the trading set — cross-impl known-answer vectors.
//
// Pins the TS trading-action typed digest to the SAME value the server commits
// to for all 12 trading actions (chain id 114514 / "Testnet"). The inputs mirror
// the chain's own cross-language vector set for orders and modifies;
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

// `submit_order` and `cancel_order` always sign the owner-bound string, so their
// owner-less server pins are not reachable from the sign path; see
// `OWNER_BOUND_VECTORS` below for their KATs.
const VECTORS: Vector[] = [
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
  // The other two TWAP signing strings. Both digests come from the NODE's own
  // cross-language vectors, not from this SDK, so the fixture cannot agree with
  // a bug in our own encoder. `randomize` selects
  // V3 whatever the leg, which is why the one-way case still signs a leg word.
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
        position_side: 'long',
      } as TwapOrder,
    },
    nonce: 48n,
    digest: '066a16f20ed5edc16d3e2a165321a45f3aaacd67ef7dbad637f453c4ce1f087e',
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
        randomize: true,
      } as TwapOrder,
    },
    nonce: 48n,
    digest: '7c20f4608b60fa7716d4895639847e7be6af0bedddc5a4926b2495ddb16866d5',
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
        position_side: 'short',
        randomize: true,
      } as TwapOrder,
    },
    nonce: 48n,
    digest: '9f982c8f8403e119b224bb52f2f72367074839ca7b07d8679740975ff175da78',
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
  it('reproduces all 13 server KAT digests byte-for-byte (chain 114514)', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    expect(VECTORS.length).toBe(13);
    for (const v of VECTORS) {
      const built = await buildTypedOrder(v.actionType, v.payload, '', v.nonce, CHAIN_ID);
      const digest = await typedOrderDigest(built);
      expect(toHex(digest), `digest mismatch for ${v.actionType}`).toBe(v.digest);
    }
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

  it('isTypedOrderAction / TYPED_ORDER_ACTION_TYPES cover exactly the 16 trading actions', async () => {
    const { isTypedOrderAction, TYPED_ORDER_ACTION_TYPES } = await import(
      '../src/native/typed_orders.js'
    );
    // 12 original trading actions + the scale-ladder pair (scale_order /
    // cancel_scale) + the chase pair (chase_order / cancel_chase).
    expect(TYPED_ORDER_ACTION_TYPES.length).toBe(16);
    expect(isTypedOrderAction('submit_order')).toBe(true);
    expect(isTypedOrderAction('cancel_order')).toBe(true);
    expect(isTypedOrderAction('batch_cancel')).toBe(true);
    expect(isTypedOrderAction('scale_order')).toBe(true);
    expect(isTypedOrderAction('cancel_scale')).toBe(true);
    expect(isTypedOrderAction('chase_order')).toBe(true);
    expect(isTypedOrderAction('cancel_chase')).toBe(true);
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
    it('owner-supporting actions cover the digest-level set, not batch_order', async () => {
      const { supportsOwner } = await import('../src/native/typed_orders.js');
      for (const v of OWNER_VECTORS) expect(supportsOwner(v.actionType)).toBe(true);
      for (const v of OWNER_BOUND_VECTORS) expect(supportsOwner(v.actionType)).toBe(true);
      // batch_order carries its owner in `BatchOrder.owner`, NOT the digest-level
      // owner — so it is NOT a digest-level owner-supporting action.
      expect(supportsOwner('batch_order')).toBe(false);
      expect(supportsOwner('scale_order')).toBe(false);
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

    it('submit_order / cancel_order always bind the wire owner', async () => {
      const { buildTypedOrder, typedOrderDigest } = await import(
        '../src/native/typed_orders.js'
      );
      const order = sampleOrder();
      const plain = await buildTypedOrder('submit_order', { order }, '', 40n, CHAIN_ID);
      expect(plain.withOwner).toBe(true);
      expect(plain.owner).toBe(OWNER);
      // A digest-level owner equal to the wire owner is the same digest.
      const same = await buildTypedOrder('submit_order', { order }, '', 40n, CHAIN_ID, OWNER);
      expect(toHex(await typedOrderDigest(same))).toBe(toHex(await typedOrderDigest(plain)));
      // A different digest-level owner would sign one owner and send another.
      await expect(
        buildTypedOrder('submit_order', { order }, '', 40n, CHAIN_ID, OWNER_BIND),
      ).rejects.toThrow(/differs from the wire body owner/);
      await expect(
        buildTypedOrder(
          'cancel_order',
          { cancel: { market: 1, oid: 1 } as unknown as NativeCancel },
          '',
          1n,
          CHAIN_ID,
        ),
      ).rejects.toThrow(/owner is required/);
    });

    // The node reads `owner` out of the POSTed spot body to pick its digest
    // variant. A client that binds the owner only at the digest level, or only in
    // the body, signs a different digest than the node rebuilds.
    it('a spot body owner binds the SAME digest as the digest-level owner', async () => {
      const { buildTypedOrder, typedOrderDigest } = await import(
        '../src/native/typed_orders.js'
      );
      const cases: { actionType: string; plain: TypedOrderPayload; owned: TypedOrderPayload }[] = [
        {
          actionType: 'spot_order',
          plain: {
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
          owned: {
            order: {
              owner: OWNER_BIND,
              pair: 3,
              side: 'bid',
              size: 50,
              limit_px: 100_000_000,
              tif: 'ioc',
              stp_mode: 'cancel_oldest',
              cloid: RUST_CLOID,
            } as NativeSpotOrder,
          },
        },
        {
          actionType: 'spot_cancel',
          plain: { cancel: { pair: 3, oid: 99 } as NativeSpotCancel },
          owned: { cancel: { owner: OWNER_BIND, pair: 3, oid: 99 } as NativeSpotCancel },
        },
      ];
      for (const c of cases) {
        const viaBody = await buildTypedOrder(c.actionType, c.owned, '', 1n, CHAIN_ID);
        expect(viaBody.withOwner, `${c.actionType} body withOwner`).toBe(true);
        expect(viaBody.owner, `${c.actionType} body owner`).toBe(OWNER_BIND);
        const viaArg = await buildTypedOrder(
          c.actionType,
          c.plain,
          '',
          1n,
          CHAIN_ID,
          OWNER_BIND,
        );
        expect(toHex(await typedOrderDigest(viaBody)), `${c.actionType} digest`).toBe(
          toHex(await typedOrderDigest(viaArg)),
        );
        // Absent owner keeps the pre-change digest.
        const plain = await buildTypedOrder(c.actionType, c.plain, '', 1n, CHAIN_ID);
        expect(plain.withOwner, `${c.actionType} plain withOwner`).toBe(false);
        expect(
          toHex(await typedOrderDigest(plain)),
          `${c.actionType} plain digest`,
        ).not.toBe(toHex(await typedOrderDigest(viaBody)));
      }
    });

    it('REFUSES a spot body owner that differs from the digest-level owner', async () => {
      const { buildTypedOrder } = await import('../src/native/typed_orders.js');
      const payload: TypedOrderPayload = {
        cancel: { owner: OWNER_BIND, pair: 3, oid: 99 } as NativeSpotCancel,
      };
      await expect(
        buildTypedOrder('spot_cancel', payload, '', 1n, CHAIN_ID, addr(0x11)),
      ).rejects.toThrow(/must carry the same owner/);
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

// ============================================================================
// Optional action-expiry (`expiresAfter`) on the trading set. The fold shares
// the chain-pinned `foldExpiryTypeString` + trailing-word rule with the account
// set (chain-pinned in typed.test.ts); these guard the trading-path plumbing:
// expiry=0 stays byte-identical, non-zero perturbs the digest + folds the type.
// ============================================================================
describe.skipIf(!wasmBuilt)('trading action expiresAfter fold', () => {
  const EXP_SET = 1_735_693_200_000n;

  it('submit_order: expiry 0 is byte-identical to the plain digest', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const payload = { order: sampleOrder() };
    const plain = await typedOrderDigest(
      await buildTypedOrder('submit_order', payload, '', 40n, CHAIN_ID),
    );
    const zero = await typedOrderDigest(
      await buildTypedOrder('submit_order', payload, '', 40n, CHAIN_ID, undefined, 0n),
    );
    expect(toHex(zero)).toBe(toHex(plain));
  });

  it('submit_order: non-zero expiry perturbs the digest', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    const payload = { order: sampleOrder() };
    const plain = await typedOrderDigest(
      await buildTypedOrder('submit_order', payload, '', 40n, CHAIN_ID),
    );
    const set = await typedOrderDigest(
      await buildTypedOrder('submit_order', payload, '', 40n, CHAIN_ID, undefined, EXP_SET),
    );
    expect(toHex(set)).not.toBe(toHex(plain));
  });

  it('folded encodeType splices ,uint64 expiresAfter before the paren', async () => {
    const { encodeOrderType } = await import('../src/native/typed_orders.js');
    const { foldExpiryTypeString } = await import('../src/native/typed.js');
    const base = encodeOrderType('cancel_order');
    expect(foldExpiryTypeString(base, 0n)).toBe(base);
    expect(foldExpiryTypeString(base, EXP_SET)).toBe(
      'MetaFluxTransaction:CancelOrder(string metafluxChain,uint32 market,uint64 oid,uint64 nonce,uint64 expiresAfter)',
    );
  });

  it('typedOrderRequestBody omits expires_after at 0, carries it when set', async () => {
    const { signTypedOrder, typedOrderRequestBody } = await import(
      '../src/native/typed_orders.js'
    );
    const privKey = new Uint8Array(32).fill(0x42);
    const payload = { order: sampleOrder() };
    const json = '{"type":"submit_order","params":{}}';
    const zero = await signTypedOrder(privKey, 'submit_order', payload, json, 40n, CHAIN_ID);
    expect(typedOrderRequestBody(zero).includes('expires_after')).toBe(false);
    const set = await signTypedOrder(
      privKey,
      'submit_order',
      payload,
      json,
      40n,
      CHAIN_ID,
      undefined,
      EXP_SET,
    );
    expect(typedOrderRequestBody(set).includes(`"expires_after":${EXP_SET}`)).toBe(true);
  });
});

// ── owner-bound forms (agent signing, metaflux#172) ──────────────────────────
//
// `submit_order` / `cancel_order` always bind their mandatory wire owner;
// `schedule_cancel` / `twap_order` bind `params.owner` when present. Node KATs:
// chain 114514, owner 0x11..11.

const OWNER_11 = addr(0x11);

/// The node's owner-bound order fixture: no cloid, no builder, no leg, no trigger.
function boundOrder(): NativeOrder {
  return {
    owner: OWNER_11,
    market: 1,
    side: 'bid',
    kind: 'limit',
    size: 1_000,
    limit_px: 5_000_000_000_000,
    tif: 'gtc',
    stp_mode: 'cancel_oldest',
    reduce_only: false,
  };
}

function boundTwap(extra: Partial<TwapOrder>): TwapOrder {
  return {
    owner: OWNER_11,
    market: 4,
    side: 'ask',
    total_size: 1_000,
    slice_count: 10,
    delay_ms: 500,
    reduce_only: true,
    ...extra,
  };
}

const OWNER_BOUND_VECTORS: Vector[] = [
  {
    actionType: 'submit_order',
    payload: { order: boundOrder() },
    nonce: 7n,
    digest: 'e8bd3a1ac347a666d1cb380be7162fda93c878bc34d9172bbacdd2521aac155b',
  },
  {
    actionType: 'cancel_order',
    payload: { cancel: { owner: OWNER_11, market: 1, oid: 42 } as NativeCancel },
    nonce: 7n,
    digest: '58960111f53e7a47f006d040f2bc007ba988d2dbcb3b0806bbf6906bd8fe0548',
  },
  {
    actionType: 'schedule_cancel',
    payload: { params: { owner: OWNER_11, cancel_at_block: 9_000 } as ScheduleCancel },
    nonce: 7n,
    digest: 'c7256bff6f4ff5a3400a370d424bfe2924c22e3a06a9de4db3fdc1038bb812dd',
  },
  {
    actionType: 'twap_order',
    payload: { params: boundTwap({}) },
    nonce: 48n,
    digest: 'f5c885724ae108a608a83119e71a84bbac1d9348b59cfe789d7bc90fa7c9855a',
  },
  {
    actionType: 'twap_order',
    payload: { params: boundTwap({ position_side: 'long' }) },
    nonce: 48n,
    digest: 'd97d4ad88b28ce4aa47bdce1e9244e18a0f88f45011160fae932119faea1b18e',
  },
  {
    actionType: 'twap_order',
    payload: { params: boundTwap({ position_side: 'short', randomize: true }) },
    nonce: 48n,
    digest: '914d04d6544236461894a5fdb8df985717983a5380a0c17e64fa3c00cd51e8bc',
  },
];

describe.skipIf(!wasmBuilt)('EIP-712 typed signing — owner-bound forms', () => {
  it('reproduces the node owner-bound KATs byte-for-byte', async () => {
    const { buildTypedOrder, typedOrderDigest } = await import(
      '../src/native/typed_orders.js'
    );
    for (const v of OWNER_BOUND_VECTORS) {
      const built = await buildTypedOrder(v.actionType, v.payload, '', v.nonce, CHAIN_ID);
      expect(built.withOwner, `${v.actionType} withOwner`).toBe(true);
      expect(built.owner, `${v.actionType} owner`).toBe(OWNER_11);
      expect(toHex(await typedOrderDigest(built)), `${v.actionType} digest`).toBe(v.digest);
    }
  });

  it('the trail form binds the owner before the order words and trailPx before the nonce', async () => {
    // The node fixture carries `trailPx 7` with an EMPTY trigger block, which
    // the wire type cannot express (`tpsl` is `"tp"` / `"sl"`), so the trail
    // word is spliced in at the position `encodeOrderData` uses.
    const { buildTypedOrder, typedOrderDigest, encodeOrderType } = await import(
      '../src/native/typed_orders.js'
    );
    const { be32 } = await import('../src/native/digest.js');
    expect(encodeOrderType('submit_order', true, true)).toBe(
      'MetaFluxTransaction:SubmitOrder(string metafluxChain,address owner,uint32 market,string side,string kind,uint64 size,uint64 limitPx,string tif,string stpMode,bool reduceOnly,string cloid,uint16 builderFee,address builderUser,string positionSide,uint64 triggerPx,bool triggerIsMarket,string triggerTpsl,uint64 trailPx,uint64 nonce)',
    );
    const plain = await buildTypedOrder('submit_order', { order: boundOrder() }, '', 7n, CHAIN_ID);
    const nonceWord = plain.words[plain.words.length - 1]!;
    const trailed = {
      ...plain,
      withTrail: true,
      words: [...plain.words.slice(0, -1), be32(7n), nonceWord],
    };
    expect(toHex(await typedOrderDigest(trailed))).toBe(
      '640607ceda3c78990eb3c95768c69a42f7df84305ccb584aa7a077e79fc13f57',
    );
  });

  it('schedule_cancel / twap_order keep the owner-less string without params.owner', async () => {
    const { buildTypedOrder, typedOrderDigest, encodeOrderType } = await import(
      '../src/native/typed_orders.js'
    );
    expect(encodeOrderType('schedule_cancel', true)).toBe(
      'MetaFluxTransaction:ScheduleCancel(string metafluxChain,address owner,uint64 cancelAtBlock,uint64 nonce)',
    );
    expect(encodeOrderType('twap_order', true)).toBe(
      'MetaFluxTransaction:TwapOrder(string metafluxChain,address owner,uint32 market,string side,uint64 totalSize,uint32 sliceCount,uint64 delayMs,bool reduceOnly,uint64 nonce)',
    );
    for (const v of OWNER_BOUND_VECTORS.filter((x) => x.actionType !== 'submit_order' && x.actionType !== 'cancel_order')) {
      const { owner: _owner, ...rest } = v.payload.params as { owner?: string };
      const plain = await buildTypedOrder(v.actionType, { params: rest as TypedOrderPayload['params'] }, '', v.nonce, CHAIN_ID);
      expect(plain.withOwner).toBe(false);
      expect(toHex(await typedOrderDigest(plain))).not.toBe(v.digest);
      // A digest-level owner binds the same digest as params.owner.
      const viaArg = await buildTypedOrder(v.actionType, { params: rest as TypedOrderPayload['params'] }, '', v.nonce, CHAIN_ID, OWNER_11);
      expect(toHex(await typedOrderDigest(viaArg))).toBe(v.digest);
    }
  });
});
