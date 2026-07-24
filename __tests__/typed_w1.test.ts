// W1 typed-action KAT — RFQ / FBA microstructure + the pm_unenroll digest alias.
//
// Pins the TS typed-action digest for the W1 additions so a drift in field
// order / type / flattening is caught before it reaches the wire:
//   - rfq_request / rfq_accept / fba_submit  (NEW sender-authorized typed actions)
//   - pm_unenroll             (NEW paramless tag, ALIAS of UserPortfolioMargin{false})
//
// (The dead `encrypted_order_submit` alias was dropped — the node refuses it at
// admission. Use `submit_encrypted_order`.)
//
// There is no pinned cross-impl server fixture for these yet, so the contract is
// asserted three ways: (1) the encodeType strings match the node's frozen type
// strings byte-for-byte; (2) the alias reproduces the EXACT digest of the
// action it aliases (the node reuses the same TypedAction); (3) a regression pin
// on the computed digest for the three new shapes. All over the same 0x1901
// machinery the 41 contract KATs already validate.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

const CHAIN_ID = 114514;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// The frozen node EIP-712 type strings these actions must reproduce (verbatim
// from the W1 node `signing_typed_*` encoders).
const ENCODE_TYPES = {
  rfq_request:
    'MetaFluxTransaction:RfqRequest(string metafluxChain,uint32 market,uint8 side,uint64 size,bool hasLimitPx,uint64 limitPx,uint64 expiryMs,bool hasStpGroup,uint64 stpGroup,uint64 nonce)',
  rfq_quote:
    'MetaFluxTransaction:RfqQuote(string metafluxChain,uint64 rfqId,uint64 price,uint64 maxSize,uint64 validUntilMs,bool hasStpGroup,uint64 stpGroup,uint64 nonce)',
  rfq_quote_with_owner:
    'MetaFluxTransaction:RfqQuote(string metafluxChain,address owner,uint64 rfqId,uint64 price,uint64 maxSize,uint64 validUntilMs,bool hasStpGroup,uint64 stpGroup,uint64 nonce)',
  vault_distribute:
    'MetaFluxTransaction:VaultDistribute(string metafluxChain,uint64 vaultId,string pnl,uint64 nonce)',
  claim_builder_rewards:
    'MetaFluxTransaction:ClaimBuilderRewards(string metafluxChain,uint64 nonce)',
  claim_referral_rewards:
    'MetaFluxTransaction:ClaimReferralRewards(string metafluxChain,uint64 nonce)',
  rfq_accept:
    'MetaFluxTransaction:RfqAccept(string metafluxChain,uint64 rfqId,uint32 quoteIdx,uint64 size,uint64 nonce)',
  fba_submit:
    'MetaFluxTransaction:FbaSubmit(string metafluxChain,uint32 market,uint8 side,uint64 size,uint64 price,bool hasStpGroup,uint64 stpGroup,uint64 nonce)',
  pm_unenroll:
    'MetaFluxTransaction:UserPortfolioMargin(string metafluxChain,bool enroll,uint64 nonce)',
} as const;

// Regression digest pins for the three new shapes (chain 114514). Computed by
// the same machinery as the 41 contract KATs; pinned so a field-order / type /
// flattening drift fails loudly.
const DIGEST_PINS = {
  rfq_request: 'db5a2fe0507c166abdc89f952b94270af4d766256b7bd74ceb3eee6328b3cf13',
  rfq_accept: '85d103b3442922dbf349b651cc6517fcd2c888e10e670e3209f9151d8e43f598',
  fba_submit: '7e8ad865c2e04cf58db4a2a4e069cd331b9426343c7b55fb62ba0ed493d023de',
} as const;

describe('W1 typed-action encodeType strings (frozen contract)', () => {
  it('match the node type strings byte-for-byte', async () => {
    const { encodeType, primaryType } = await import('../src/native/typed.js');
    expect(encodeType('rfq_request')).toBe(ENCODE_TYPES.rfq_request);
    expect(encodeType('rfq_quote')).toBe(ENCODE_TYPES.rfq_quote);
    // The owner-carrying variant inserts `address owner` after metafluxChain,
    // selecting the node's `RFQ_QUOTE_WITH_OWNER` type.
    expect(encodeType('rfq_quote', true)).toBe(ENCODE_TYPES.rfq_quote_with_owner);
    expect(encodeType('vault_distribute')).toBe(ENCODE_TYPES.vault_distribute);
    expect(encodeType('claim_builder_rewards')).toBe(ENCODE_TYPES.claim_builder_rewards);
    expect(encodeType('claim_referral_rewards')).toBe(
      ENCODE_TYPES.claim_referral_rewards,
    );
    expect(encodeType('rfq_accept')).toBe(ENCODE_TYPES.rfq_accept);
    expect(encodeType('fba_submit')).toBe(ENCODE_TYPES.fba_submit);
    // The pm_unenroll alias reuses the existing primary type (NOT a new struct).
    expect(encodeType('pm_unenroll')).toBe(ENCODE_TYPES.pm_unenroll);
    expect(primaryType('pm_unenroll')).toBe(
      'MetaFluxTransaction:UserPortfolioMargin',
    );
  });
});

describe('W1 typed-action wire shapes', () => {
  it('rfq_request flattens Option<u64> + signs side as a uint8 name', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    // Both optionals present.
    const full = buildTyped(
      'rfq_request',
      {
        market: 7,
        side: 'Bid',
        size: 1000n,
        limit_px: 42_000n,
        expiry_ms: 1_700_000_000_000,
        stp_group: 3,
      },
      11n,
      CHAIN_ID,
    );
    expect(JSON.parse(full.actionJson)).toEqual({
      type: 'rfq_request',
      params: {
        market: 7,
        side: 'Bid',
        size: 1000,
        limit_px: 42000,
        expiry_ms: 1_700_000_000_000,
        stp_group: 3,
      },
    });
    const data = typedDataV4(full);
    expect(data.types[data.primaryType].map((f) => f.name)).toEqual([
      'metafluxChain',
      'market',
      'side',
      'size',
      'hasLimitPx',
      'limitPx',
      'expiryMs',
      'hasStpGroup',
      'stpGroup',
      'nonce',
    ]);
    // side rides the v4 message + signed word as the uint8 code (Bid=0).
    expect(data.message.side).toBe(0);
    expect(data.message.hasLimitPx).toBe(true);
    expect(data.message.limitPx).toBe(42000);
    expect(data.message.hasStpGroup).toBe(true);
    expect(data.message.stpGroup).toBe(3);

    // Both optionals absent: keys omitted on the wire; presence halves false.
    const bare = buildTyped(
      'rfq_request',
      { market: 7, side: 'Ask', size: 1000, expiry_ms: 0 },
      11n,
      CHAIN_ID,
    );
    expect(JSON.parse(bare.actionJson)).toEqual({
      type: 'rfq_request',
      params: { market: 7, side: 'Ask', size: 1000, expiry_ms: 0 },
    });
    const bareData = typedDataV4(bare);
    expect(bareData.message.side).toBe(1); // Ask=1
    expect(bareData.message.hasLimitPx).toBe(false);
    expect(bareData.message.limitPx).toBe(0);
    expect(bareData.message.hasStpGroup).toBe(false);
    expect(bareData.message.stpGroup).toBe(0);
  });

  it('fba_submit names the price field + flattens stp_group', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const built = buildTyped(
      'fba_submit',
      { market: 5, side: 'Ask', size: 250n, price: 30_000n, stp_group: null },
      13n,
      CHAIN_ID,
    );
    // stp_group null => absent (omitted), NOT serialized as null.
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'fba_submit',
      params: { market: 5, side: 'Ask', size: 250, price: 30000 },
    });
  });

  it('pm_unenroll emits the bare paramless envelope', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const built = buildTyped('pm_unenroll', {}, 4n, CHAIN_ID);
    expect(built.actionJson).toBe('{"type":"pm_unenroll"}');
  });
});

describe.skipIf(!wasmBuilt)('W1 typed-action digests', () => {
  it('pm_unenroll reproduces the UserPortfolioMargin{enroll:false} digest exactly', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const aliasDigest = await typedActionDigest(
      buildTyped('pm_unenroll', {}, 4n, CHAIN_ID),
    );
    const baseDigest = await typedActionDigest(
      buildTyped('user_portfolio_margin', { enroll: false }, 4n, CHAIN_ID),
    );
    expect(toHex(aliasDigest)).toBe(toHex(baseDigest));
    // And it must NOT collide with the enroll:true digest.
    const enrollDigest = await typedActionDigest(
      buildTyped('user_portfolio_margin', { enroll: true }, 4n, CHAIN_ID),
    );
    expect(toHex(aliasDigest)).not.toBe(toHex(enrollDigest));
  });

  it('reproduces the rfq_request / rfq_accept / fba_submit digest pins', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const rfqRequest = await typedActionDigest(
      buildTyped(
        'rfq_request',
        {
          market: 7,
          side: 'Bid',
          size: 1000n,
          limit_px: 42_000n,
          expiry_ms: 1_700_000_000_000,
          stp_group: 3,
        },
        11n,
        CHAIN_ID,
      ),
    );
    expect(toHex(rfqRequest)).toBe(DIGEST_PINS.rfq_request);

    const rfqAccept = await typedActionDigest(
      buildTyped('rfq_accept', { rfq_id: 99, quote_idx: 1, size: 500n }, 12n, CHAIN_ID),
    );
    expect(toHex(rfqAccept)).toBe(DIGEST_PINS.rfq_accept);

    const fbaSubmit = await typedActionDigest(
      buildTyped(
        'fba_submit',
        { market: 5, side: 'Ask', size: 250n, price: 30_000n, stp_group: 9 },
        13n,
        CHAIN_ID,
      ),
    );
    expect(toHex(fbaSubmit)).toBe(DIGEST_PINS.fba_submit);
  });

  it('rfq_request sign → recover round-trips to the signing address', async () => {
    const { signTypedAction, recoverTypedSigner } = await import(
      '../src/native/typed.js'
    );
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wallet/wasm.js');

    const privKey = new Uint8Array(32).fill(0x5b);
    const probe = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probe);
    const probePub = await recoverPubkey(probeSig, probe);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const payload = {
      market: 7,
      side: 'Bid',
      size: 1000n,
      limit_px: 42_000n,
      expiry_ms: 1_700_000_000_000,
      stp_group: 3,
    };
    const signed = await signTypedAction(privKey, 'rfq_request', payload, 11n, CHAIN_ID);
    expect(signed.signature.length).toBe(2 + 130);
    const recovered = await recoverTypedSigner(signed, 'rfq_request', payload, CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('rejects a non-PascalCase side', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    expect(() =>
      buildTyped(
        'rfq_request',
        { market: 7, side: 'bid', size: 1000n, expiry_ms: 0 },
        11n,
        CHAIN_ID,
      ),
    ).toThrow(/side must be one of/);
  });
});

// ── P0+P1: node-authoritative KATs (rfq_quote / vault_distribute / claims) ──
//
// Unlike the self-computed regression pins above, these five digests are COPIED
// VERBATIM from the node's own `typed_action_kat_vectors` output
// (`core-state::signing_typed_tests`, chain 114514) — the SAME inputs the node
// signs. A CROSS-IMPL match proves the TS digest equals the byte the node
// verifies; a drift 401s the action. Never edit these by hand — regenerate from
// `cargo test -p core-state typed_action_kat_vectors -- --nocapture`.
const NODE_KAT = {
  // owner=None, rfq_id=9, price=105, max_size=500, valid_until_ms=9000,
  // stp_group absent, nonce=54.
  rfq_quote: '86ea54e354da6e4626aeaf4001a27bee86793e4fde366d0cfa8662ace831ee25',
  // owner=0xe4…e4 (addr(0xE4)), else identical, nonce=54.
  rfq_quote_with_owner:
    '6583f5d725c522a8a0adbec966da23784dff48c90be3835086e0a4f070179bed',
  // vault_id=42, pnl="250.75", nonce=18.
  vault_distribute:
    'a51d392ef7a24aef8600eaa3e31ff67b32f9c35ed3383045c33f330b605f3939',
  // nonce=18.
  claim_builder_rewards:
    'dd59fd416f3ac3a676accca8202f4a39828f869cbf5df63c42cdcff835d0fcb3',
  // nonce=18.
  claim_referral_rewards:
    'f8b8d9b7762ef89c7efb12e9b5150ce5b2ffeb8045e8656e77684a27c3683e60',
} as const;

const KAT_OWNER = '0xe4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';

describe('P0+P1 wire shapes (rfq_quote)', () => {
  it('rfq_quote flattens Option<u64> stp_group + omits absent keys', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    // stp_group present.
    const full = buildTyped(
      'rfq_quote',
      { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000, stp_group: 3 },
      54n,
      CHAIN_ID,
    );
    expect(JSON.parse(full.actionJson)).toEqual({
      type: 'rfq_quote',
      params: { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000, stp_group: 3 },
    });
    const data = typedDataV4(full);
    expect(data.types[data.primaryType].map((f) => f.name)).toEqual([
      'metafluxChain',
      'rfqId',
      'price',
      'maxSize',
      'validUntilMs',
      'hasStpGroup',
      'stpGroup',
      'nonce',
    ]);
    expect(data.message.hasStpGroup).toBe(true);
    expect(data.message.stpGroup).toBe(3);

    // stp_group absent: key omitted on the wire; presence half false.
    const bare = buildTyped(
      'rfq_quote',
      { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000 },
      54n,
      CHAIN_ID,
    );
    expect(JSON.parse(bare.actionJson)).toEqual({
      type: 'rfq_quote',
      params: { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000 },
    });
    expect(typedDataV4(bare).message.hasStpGroup).toBe(false);
  });

  it('rfq_quote with owner prepends params.owner + binds the owner word', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const built = buildTyped(
      'rfq_quote',
      { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000 },
      54n,
      CHAIN_ID,
      KAT_OWNER,
    );
    // owner rides FIRST in params.owner (readback key), then the signed fields.
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'rfq_quote',
      params: {
        owner: KAT_OWNER,
        rfq_id: 9,
        price: 105,
        max_size: 500,
        valid_until_ms: 9000,
      },
    });
  });
});

describe.skipIf(!wasmBuilt)('P0+P1 node-authoritative typed digests', () => {
  it('rfq_quote (owner-less) matches the node KAT', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const digest = await typedActionDigest(
      buildTyped(
        'rfq_quote',
        { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000 },
        54n,
        CHAIN_ID,
      ),
    );
    expect(toHex(digest)).toBe(NODE_KAT.rfq_quote);
  });

  it('rfq_quote (with owner) matches the node RFQ_QUOTE_WITH_OWNER KAT', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const digest = await typedActionDigest(
      buildTyped(
        'rfq_quote',
        { rfq_id: 9, price: 105, max_size: 500, valid_until_ms: 9000 },
        54n,
        CHAIN_ID,
        KAT_OWNER,
      ),
    );
    expect(toHex(digest)).toBe(NODE_KAT.rfq_quote_with_owner);
    // The owner word genuinely moves the digest.
    expect(toHex(digest)).not.toBe(NODE_KAT.rfq_quote);
  });

  it('vault_distribute matches the node KAT (pnl hashed verbatim)', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const digest = await typedActionDigest(
      buildTyped('vault_distribute', { vault_id: 42, pnl: '250.75' }, 18n, CHAIN_ID),
    );
    expect(toHex(digest)).toBe(NODE_KAT.vault_distribute);
  });

  it('claim_builder_rewards / claim_referral_rewards match the node KATs', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const builder = await typedActionDigest(
      buildTyped('claim_builder_rewards', {}, 18n, CHAIN_ID),
    );
    expect(toHex(builder)).toBe(NODE_KAT.claim_builder_rewards);
    const referral = await typedActionDigest(
      buildTyped('claim_referral_rewards', {}, 18n, CHAIN_ID),
    );
    expect(toHex(referral)).toBe(NODE_KAT.claim_referral_rewards);
    // The two paramless claims are distinct primary types → distinct digests.
    expect(toHex(builder)).not.toBe(toHex(referral));
  });

  it('the paramless claims emit the required "params":{} wire body', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    // The node struct-variants carry `params: Claim*RewardsParams {}` (no serde
    // default), so the key MUST be present — a bare `{"type":...}` would 400.
    expect(buildTyped('claim_builder_rewards', {}, 1n, CHAIN_ID).actionJson).toBe(
      '{"type":"claim_builder_rewards","params":{}}',
    );
    expect(buildTyped('claim_referral_rewards', {}, 1n, CHAIN_ID).actionJson).toBe(
      '{"type":"claim_referral_rewards","params":{}}',
    );
  });
});
