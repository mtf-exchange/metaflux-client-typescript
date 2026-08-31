// EIP-712 typed signing — the MIP-1 spot-deployer lane, the MIP-3 perp-deployer
// lane and its deployer oracle, the metaliquidity operator grant, and the BOLE
// `borrow_lend` flow.
//
// The type strings below are copied VERBATIM from the node's frozen constants
// (the chain's frozen typed-signing constants). They are the contract: if `encodeType`
// drifts from one of them, this SDK signs a struct the node will not verify.
//
// The digest assertions here are RELATIONAL, not absolute — each one proves a
// field reaches the digest, or that two inputs separate. The absolute 32-byte
// known-answer vectors for all 58 actions live in `typed.test.ts` and
// carry the chain's OWN digests, from its cross-language vector set.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBuilt = existsSync(
  resolve(__dirname, '..', 'pkg', 'metaflux_client_wasm.js'),
);

const CHAIN_ID = 114514;

/// `addr(byte)` in the node fixtures = that byte repeated 20 times.
function addr(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ── encodeType: byte-for-byte against the node's frozen constants ────────────

describe('typed encodeType — spot deployer / operator / BOLE / MIP-3 oracle', () => {
  const FROZEN: Record<string, string> = {
    spot_register_token:
      'MetaFluxTransaction:SpotRegisterToken(string metafluxChain,string symbol,uint8 szDecimals,uint8 weiDecimals,string maxDeployFee,uint64 nonce)',
    spot_register_pair:
      'MetaFluxTransaction:SpotRegisterPair(string metafluxChain,uint32 base,uint32 quote,string name,string maxDeployFee,uint64 nonce)',
    spot_set_pair_params:
      'MetaFluxTransaction:SpotSetPairParams(string metafluxChain,uint32 pair,uint32 takerFeeDbps,uint32 makerFeeDbps,uint64 minNotionalCents,uint64 nonce)',
    spot_set_pair_active:
      'MetaFluxTransaction:SpotSetPairActive(string metafluxChain,uint32 pair,bool active,uint64 nonce)',
    spot_seed_holders:
      'MetaFluxTransaction:SpotSeedHolders(string metafluxChain,uint32 asset,address[] holders,string[] amounts,uint64 nonce)',
    spot_finalize_supply:
      'MetaFluxTransaction:SpotFinalizeSupply(string metafluxChain,uint32 asset,string maxSupply,uint64 nonce)',
    register_metaliquidity_operator:
      'MetaFluxTransaction:RegisterMetaliquidityOperator(string metafluxChain,uint64 vaultId,address operator,bool allowed,uint64 expiresAtMs,uint64 nonce)',
    borrow_lend:
      'MetaFluxTransaction:BorrowLend(string metafluxChain,uint8 kind,string amount,uint64 nonce)',
    mip3_set_oracle_px:
      'MetaFluxTransaction:Mip3SetOraclePx(string metafluxChain,uint32 asset,string px,uint64 nonce)',
  };

  it('matches the node type string for all nine actions', async () => {
    const { encodeType } = await import('../src/native/typed.js');
    for (const [actionType, frozen] of Object.entries(FROZEN)) {
      expect(encodeType(actionType)).toBe(frozen);
    }
  });

  it('none of the nine takes an agent-resolved owner', async () => {
    const { accountSupportsOwner } = await import('../src/native/typed.js');
    for (const actionType of Object.keys(FROZEN)) {
      expect(accountSupportsOwner(actionType)).toBe(false);
    }
  });
});

// ── wire shape: what lands in the POST params ────────────────────────────────

describe('typed wire shape — spot deployer / operator / BOLE / MIP-3 oracle', () => {
  it('decimal fields ride verbatim into the POST action', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const tok = buildTyped(
      'spot_register_token',
      { symbol: 'WIF', sz_decimals: 4, wei_decimals: 8, max_deploy_fee: '1500.5' },
      58n,
      CHAIN_ID,
    );
    expect(JSON.parse(tok.actionJson)).toEqual({
      type: 'spot_register_token',
      params: { symbol: 'WIF', sz_decimals: 4, wei_decimals: 8, max_deploy_fee: '1500.5' },
    });
    const seal = buildTyped(
      'spot_finalize_supply',
      { asset: 77, max_supply: '1000250.75' },
      63n,
      CHAIN_ID,
    );
    expect(seal.actionJson.includes('"max_supply":"1000250.75"')).toBe(true);
  });

  /// The node hashes the px string it is SENT. If the builder ever re-formatted
  /// the px between signing and posting, every push would fail signer auth.
  it('mip3_set_oracle_px posts the exact px string it signs', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'mip3_set_oracle_px',
      { asset: 42, px: '1250.500001' },
      210n,
      CHAIN_ID,
    );
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'mip3_set_oracle_px',
      params: { asset: 42, px: '1250.500001' },
    });
    const data = typedDataV4(built);
    expect(data.message.px).toBe('1250.500001');
    const fields = data.types[data.primaryType] ?? [];
    expect(fields.find((t) => t.name === 'px')?.type).toBe('string');
  });

  it('spot_seed_holders carries both parallel arrays verbatim', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'spot_seed_holders',
      {
        asset: 77,
        holders: [addr(0x51), addr(0x52)],
        amounts: ['1000000', '250.75'],
      },
      62n,
      CHAIN_ID,
    );
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'spot_seed_holders',
      params: {
        asset: 77,
        holders: [addr(0x51), addr(0x52)],
        amounts: ['1000000', '250.75'],
      },
    });
    const data = typedDataV4(built);
    expect(data.message.amounts).toEqual(['1000000', '250.75']);
    const fields = data.types[data.primaryType] ?? [];
    expect(fields.find((t) => t.name === 'amounts')?.type).toBe('string[]');
    expect(fields.find((t) => t.name === 'holders')?.type).toBe('address[]');
  });

  it('borrow_lend POSTs the kind NAME and signs the uint8 code', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const codes: [string, number][] = [
      ['Lend', 0],
      ['UnLend', 1],
      ['Borrow', 2],
      ['Repay', 3],
    ];
    for (const [name, code] of codes) {
      const built = buildTyped('borrow_lend', { kind: name, amount: '1000' }, 18n, CHAIN_ID);
      expect(JSON.parse(built.actionJson)).toEqual({
        type: 'borrow_lend',
        params: { kind: name, amount: '1000' },
      });
      const data = typedDataV4(built);
      expect(data.message.kind).toBe(code);
      const fields = data.types[data.primaryType] ?? [];
      expect(fields.find((t) => t.name === 'kind')?.type).toBe('uint8');
    }
  });

  it('borrow_lend refuses a kind the node cannot deserialize', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    // The node's enum has no `rename_all`, so lowercase / snake_case spellings
    // are not wire values. `unlend` differs from `UnLend` by one letter.
    for (const bad of ['lend', 'unlend', 'un_lend', 'UNLEND', '']) {
      expect(() => buildTyped('borrow_lend', { kind: bad, amount: '1' }, 1n, CHAIN_ID)).toThrow(
        RangeError,
      );
    }
  });

  it('an omitted operator expiry signs 0 and omits the wire key', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'register_metaliquidity_operator',
      { vault_id: 42, operator: addr(0x70), allowed: true },
      34n,
      CHAIN_ID,
    );
    // The key is ABSENT on the wire — the node reads absent as never-expires.
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'register_metaliquidity_operator',
      params: { vault_id: 42, operator: addr(0x70), allowed: true },
    });
    // The digest still binds a uint64, and it is 0.
    expect(typedDataV4(built).message.expiresAtMs).toBe(0);
  });

  it('an explicit operator expiry of 0 is refused before signing', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    // The node refuses this wire form with a 400 for the same reason: absent and
    // explicit-0 digest identically, but commit to never-expires against
    // expired-at-epoch. Catching it here saves a round trip.
    expect(() =>
      buildTyped(
        'register_metaliquidity_operator',
        { vault_id: 42, operator: addr(0x70), allowed: true, expires_at_ms: 0 },
        34n,
        CHAIN_ID,
      ),
    ).toThrow(/ambiguous/);
  });

  it('a real operator expiry reaches both the wire and the message', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'register_metaliquidity_operator',
      {
        vault_id: 42,
        operator: addr(0x70),
        allowed: true,
        expires_at_ms: 1_700_000_000_000,
      },
      34n,
      CHAIN_ID,
    );
    expect(built.actionJson.includes('"expires_at_ms":1700000000000')).toBe(true);
    expect(typedDataV4(built).message.expiresAtMs).toBe(1_700_000_000_000);
  });
});

// ── digest binding: every consumed field must move the digest ────────────────
//
// A field the node reads but the digest does not cover is a splice seam: a relay
// could rewrite it under a replayed signature. Each case below mutates ONE field
// and requires the digest to change.

describe.skipIf(!wasmBuilt)('typed digest binding — every field enters its digest', () => {
  /// One action, its node-fixture payload, and a mutation per field.
  const CASES: {
    actionType: string;
    payload: Record<string, unknown>;
    nonce: bigint;
    mutations: Record<string, unknown>;
  }[] = [
    {
      actionType: 'spot_register_token',
      payload: { symbol: 'WIF', sz_decimals: 4, wei_decimals: 8, max_deploy_fee: '1500.5' },
      nonce: 58n,
      mutations: {
        symbol: 'WIF2',
        sz_decimals: 5,
        wei_decimals: 9,
        max_deploy_fee: '1500.50',
      },
    },
    {
      actionType: 'spot_register_pair',
      payload: { base: 77, quote: 0, name: 'WIF/USDC', max_deploy_fee: '900' },
      nonce: 59n,
      mutations: { base: 78, quote: 1, name: 'WIF/USDT', max_deploy_fee: '900.0' },
    },
    {
      actionType: 'spot_set_pair_params',
      payload: {
        pair: 78,
        taker_fee_dbps: 45,
        maker_fee_dbps: 12,
        min_notional_cents: 1_000,
      },
      nonce: 60n,
      mutations: {
        pair: 79,
        taker_fee_dbps: 46,
        maker_fee_dbps: 13,
        min_notional_cents: 1_001,
      },
    },
    {
      actionType: 'spot_set_pair_active',
      payload: { pair: 78, active: true },
      nonce: 61n,
      mutations: { pair: 79, active: false },
    },
    {
      actionType: 'spot_seed_holders',
      payload: {
        asset: 77,
        holders: [addr(0x51), addr(0x52)],
        amounts: ['1000000', '250.75'],
      },
      nonce: 62n,
      mutations: {
        asset: 78,
        holders: [addr(0x51), addr(0x53)],
        amounts: ['1000000', '250.750'],
      },
    },
    {
      actionType: 'spot_finalize_supply',
      payload: { asset: 77, max_supply: '1000250.75' },
      nonce: 63n,
      mutations: { asset: 78, max_supply: '1000250.750' },
    },
    {
      actionType: 'register_metaliquidity_operator',
      payload: {
        vault_id: 42,
        operator: addr(0x70),
        allowed: true,
        expires_at_ms: 1_700_000_000_000,
      },
      nonce: 34n,
      mutations: {
        vault_id: 43,
        operator: addr(0x71),
        allowed: false,
        expires_at_ms: 1_700_000_000_001,
      },
    },
    {
      actionType: 'borrow_lend',
      payload: { kind: 'Lend', amount: '1000' },
      nonce: 18n,
      mutations: { kind: 'UnLend', amount: '1000.0' },
    },
  ];

  it('mutating any single field changes the digest', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    for (const c of CASES) {
      const base = toHex(
        await typedActionDigest(buildTyped(c.actionType, c.payload, c.nonce, CHAIN_ID)),
      );
      for (const [key, value] of Object.entries(c.mutations)) {
        const mutated = { ...c.payload, [key]: value };
        const got = toHex(
          await typedActionDigest(buildTyped(c.actionType, mutated, c.nonce, CHAIN_ID)),
        );
        expect(got, `${c.actionType}.${key} does not enter its digest`).not.toBe(base);
      }
    }
  });

  it('the seed rows are ORDER-bound, so no relay can re-order a distribution', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const rows = (holders: string[], amounts: string[]) =>
      buildTyped('spot_seed_holders', { asset: 77, holders, amounts }, 62n, CHAIN_ID);
    const base = toHex(
      await typedActionDigest(rows([addr(0x51), addr(0x52)], ['1000000', '250.75'])),
    );
    // Swapping the two AMOUNTS re-targets who gets what.
    const swappedAmounts = toHex(
      await typedActionDigest(rows([addr(0x51), addr(0x52)], ['250.75', '1000000'])),
    );
    // Swapping the two HOLDERS does the same from the other side.
    const swappedHolders = toHex(
      await typedActionDigest(rows([addr(0x52), addr(0x51)], ['1000000', '250.75'])),
    );
    expect(swappedAmounts).not.toBe(base);
    expect(swappedHolders).not.toBe(base);
  });

  it('the four BOLE directions sign four distinct digests', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const seen = new Set<string>();
    for (const kind of ['Lend', 'UnLend', 'Borrow', 'Repay']) {
      seen.add(
        toHex(await typedActionDigest(buildTyped('borrow_lend', { kind, amount: '1000' }, 18n, CHAIN_ID))),
      );
    }
    expect(seen.size).toBe(4);
  });
});

// ── MIP-3 perp-deployer lane ─────────────────────────────────────────────────
//
// The nine tags landed in the node but that binary is NOT released, so the live
// chain refuses every one of them today. The type strings are frozen all the
// same: they are what the node will verify against at the swap height.

describe('typed encodeType — MIP-3 perp deployer lane', () => {
  const FROZEN_PERP: Record<string, string> = {
    perp_register_asset:
      'MetaFluxTransaction:PerpRegisterAsset(string metafluxChain,string symbol,uint8 decimals,string name,uint64 nonce)',
    perp_set_oracle:
      'MetaFluxTransaction:PerpSetOracle(string metafluxChain,uint32 asset,uint16 oracleSourceMask,uint64 nonce)',
    perp_set_leverage:
      'MetaFluxTransaction:PerpSetLeverage(string metafluxChain,uint32 asset,uint8 maxLeverage,uint64 nonce)',
    perp_set_fee_tier:
      'MetaFluxTransaction:PerpSetFeeTier(string metafluxChain,uint32 asset,uint32 takerFeeDbps,uint32 makerFeeDbps,uint32 deployerFeeBps,uint64 nonce)',
    perp_set_maker_rebate:
      'MetaFluxTransaction:PerpSetMakerRebate(string metafluxChain,uint32 asset,uint16 rebateBps,uint64 nonce)',
    perp_set_min_size:
      'MetaFluxTransaction:PerpSetMinSize(string metafluxChain,uint32 asset,uint64 minOrderSize,uint64 nonce)',
    perp_activate_market:
      'MetaFluxTransaction:PerpActivateMarket(string metafluxChain,uint32 asset,uint64 nonce)',
    perp_deactivate_market:
      'MetaFluxTransaction:PerpDeactivateMarket(string metafluxChain,uint32 asset,uint64 nonce)',
    perp_set_sub_deployers:
      'MetaFluxTransaction:PerpSetSubDeployers(string metafluxChain,uint32 asset,address subDeployer,bool add,uint64 nonce)',
  };

  it('matches the node type string for all nine actions', async () => {
    const { encodeType } = await import('../src/native/typed.js');
    for (const [actionType, frozen] of Object.entries(FROZEN_PERP)) {
      expect(encodeType(actionType)).toBe(frozen);
    }
  });

  it('none of the nine takes an agent-resolved owner', async () => {
    const { accountSupportsOwner } = await import('../src/native/typed.js');
    for (const actionType of Object.keys(FROZEN_PERP)) {
      expect(accountSupportsOwner(actionType)).toBe(false);
    }
  });

  /// The dead gas-auction lane is off this wire. A `bid` key in the payload
  /// must not reach the POST action or the signed message — the handler rejects
  /// a non-zero bid, so a client that smuggled one would sign an action the
  /// node refuses.
  it('no perp deploy action carries a bid', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    for (const actionType of Object.keys(FROZEN_PERP)) {
      expect(FROZEN_PERP[actionType]).not.toContain('bid');
      const built = buildTyped(
        actionType,
        { symbol: 'GRAD:WIF', decimals: 8, name: 'GRAD', asset: 1001, oracle_source_mask: 1, max_leverage: 20,
          taker_fee_dbps: 45, maker_fee_dbps: 12, deployer_fee_bps: 6, rebate_bps: 2,
          min_order_size: 1000, sub_deployer: addr(0xaa), add: true, bid: '1' },
        1n,
        CHAIN_ID,
      );
      expect(Object.keys(JSON.parse(built.actionJson).params)).not.toContain('bid');
      expect(Object.keys(typedDataV4(built).message)).not.toContain('bid');
    }
  });
});

describe('typed wire shape — MIP-3 perp deployer lane', () => {
  /// The three legs stay SEPARATE under the digest. The node packs them itself,
  /// so a client never reproduces the packing arithmetic — and three legs that
  /// pack to the same value must still sign three different digests.
  it('perp_set_fee_tier signs each fee leg on its own', async () => {
    const { buildTyped, typedActionDigest, typedDataV4 } = await import('../src/native/typed.js');
    const tier = (taker: number, maker: number, deployer: number) =>
      buildTyped(
        'perp_set_fee_tier',
        { asset: 1001, taker_fee_dbps: taker, maker_fee_dbps: maker, deployer_fee_bps: deployer },
        204n,
        CHAIN_ID,
      );
    const msg = typedDataV4(tier(45, 12, 6)).message;
    expect(msg.takerFeeDbps).toBe(45);
    expect(msg.makerFeeDbps).toBe(12);
    expect(msg.deployerFeeBps).toBe(6);

    const seen = new Set<string>();
    for (const legs of [[45, 12, 6], [12, 45, 6], [6, 12, 45], [45, 12, 7]] as const) {
      seen.add(toHex(await typedActionDigest(tier(legs[0], legs[1], legs[2]))));
    }
    expect(seen.size).toBe(4);
  });

  /// SECURITY: a relay must not be able to re-target the delegate, nor flip a
  /// removal into a grant, under a replayed signature. Both fields are signed.
  it('perp_set_sub_deployers binds both the delegate and the add flag', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const grant = (subDeployer: string, add: boolean) =>
      buildTyped(
        'perp_set_sub_deployers',
        { asset: 1001, sub_deployer: subDeployer, add },
        209n,
        CHAIN_ID,
      );
    const base = toHex(await typedActionDigest(grant(addr(0xaa), true)));
    const otherDelegate = toHex(await typedActionDigest(grant(addr(0xbb), true)));
    const revoke = toHex(await typedActionDigest(grant(addr(0xaa), false)));
    expect(otherDelegate).not.toBe(base);
    expect(revoke).not.toBe(base);
  });

  /// `perp_activate_market` and `perp_deactivate_market` carry the SAME single
  /// field. Only the type string separates them, so an open must never sign the
  /// same digest as a close.
  it('activate and deactivate never share a digest', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const open = toHex(
      await typedActionDigest(buildTyped('perp_activate_market', { asset: 1001 }, 207n, CHAIN_ID)),
    );
    const close = toHex(
      await typedActionDigest(buildTyped('perp_deactivate_market', { asset: 1001 }, 207n, CHAIN_ID)),
    );
    expect(open).not.toBe(close);
  });

  /// The DEX name RIDES the digest, so a relay can neither insert nor swap it.
  /// A stale client that omits the name signs a different digest and is
  /// refused, instead of landing a market in the wrong namespace.
  it('perp_register_asset binds the dex name into the digest', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const digestFor = async (name: string) =>
      toHex(
        await typedActionDigest(
          buildTyped('perp_register_asset', { symbol: 'WIF', decimals: 8, name }, 201n, CHAIN_ID),
        ),
      );
    expect(await digestFor('GRAD')).not.toBe(await digestFor(''));
    expect(await digestFor('GRAD')).not.toBe(await digestFor('grad'));
  });

  /// `decimals` of `0` reads as the handler's default of 8. The SDK must pass
  /// the value through untouched: silently rewriting 0 to 8 here would sign a
  /// digest the deployer never agreed to.
  it('perp_register_asset passes decimals through verbatim, including 0', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    for (const decimals of [0, 8, 18]) {
      const built = buildTyped(
        'perp_register_asset',
        { symbol: 'GRAD:WIF', decimals, name: 'GRAD' },
        201n,
        CHAIN_ID,
      );
      expect(JSON.parse(built.actionJson).params.decimals).toBe(decimals);
      expect(typedDataV4(built).message.decimals).toBe(decimals);
    }
  });
});
