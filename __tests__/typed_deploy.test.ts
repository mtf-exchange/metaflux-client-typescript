// EIP-712 typed signing — the MIP-1 spot-deployer lane, the metaliquidity
// operator grant, and the BOLE `borrow_lend` flow.
//
// The type strings below are copied VERBATIM from the node's frozen constants
// (`core-state` `signing_typed.rs`). They are the contract: if `encodeType`
// drifts from one of them, this SDK signs a struct the node will not verify.
//
// The digest assertions here are RELATIONAL, not absolute — each one proves a
// field reaches the digest, or that two inputs separate. The absolute 32-byte
// known-answer vectors for these eight actions still have to come from the
// node's own KAT run; they are not hand-derived here.

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

describe('typed encodeType — spot deployer / metaliquidity operator / BOLE', () => {
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
  };

  it('matches the node type string for all eight actions', async () => {
    const { encodeType } = await import('../src/native/typed.js');
    for (const [actionType, frozen] of Object.entries(FROZEN)) {
      expect(encodeType(actionType)).toBe(frozen);
    }
  });

  it('none of the eight takes an agent-resolved owner', async () => {
    const { accountSupportsOwner } = await import('../src/native/typed.js');
    for (const actionType of Object.keys(FROZEN)) {
      expect(accountSupportsOwner(actionType)).toBe(false);
    }
  });
});

// ── wire shape: what lands in the POST params ────────────────────────────────

describe('typed wire shape — spot deployer / operator / BOLE', () => {
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
