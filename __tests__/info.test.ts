// MTF-native /info request-shape + envelope-unwrap tests — pure TS, no WASM.
// Mocks global fetch and asserts each InfoApi method POSTs the EXACT
// `{"type": ...}` body the server's `/info` dispatcher expects
// (per the KB spec metaflux-knowledges/api/rest/info.md), keyed by the real
// param (0x address / asset_id / coin / market_id / vault), and that the
// `{type, data}` envelope is unwrapped to the typed `data`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InfoApi } from '../src/rest/info.js';

interface Captured {
  url: string;
  method: string;
  body: string;
  contentType: string | null;
}

let captured: Captured | undefined;
// Server response — every `/info` reply is the `{type, data}` envelope. Tests
// set `nextType` + `nextData`; the mock fetch wraps them.
let nextType = '';
let nextData: unknown = {};

const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = undefined;
  nextType = '';
  nextData = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    captured = {
      url: String(url),
      method: init.method ?? 'GET',
      body: String(init.body),
      contentType: headers.get('Content-Type'),
    };
    // Echo the request `type` back in the envelope by default so the
    // `post()` unwrap validation passes; individual tests override `nextType`.
    const reqType = JSON.parse(String(init.body)).type as string;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ type: nextType || reqType, data: nextData }),
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const BASE = 'http://localhost:8080';
const ADDR = '0x00000000000000000000000000000000000000aa';
const VAULT = '0x00000000000000000000000000000000000000bb';

describe('InfoApi request shapes', () => {
  it('nodeInfo POSTs {"type":"node_info"} and unwraps `data`', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      network: 'devnet',
      chain_id: 31337,
      protocol_version: '1.0.0',
      validator_index: null,
      build_commit: 'abc1234',
      uptime_seconds: 0,
    };
    const res = await api.nodeInfo();
    expect(captured?.url).toBe('http://localhost:8080/info');
    expect(captured?.method).toBe('POST');
    expect(captured?.contentType).toBe('application/json');
    expect(JSON.parse(captured!.body)).toEqual({ type: 'node_info' });
    // Envelope unwrapped — `res` is the inner `data`, not `{type, data}`.
    expect(res.network).toBe('devnet');
    expect(res.chain_id).toBe(31337);
    expect(res.protocol_version).toBe('1.0.0');
  });

  it('accountState is keyed by 0x address (NOT a numeric account_id)', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, account_value: '0', positions: [] };
    await api.accountState(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'account_state',
      address: ADDR,
    });
  });

  it('marketInfo sends asset_id (NOT market_id)', async () => {
    const api = new InfoApi(BASE);
    nextData = { asset_id: 7, mark_px: '0', oracle_px: '0', open_interest: '0' };
    const res = await api.marketInfo(7);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'market_info',
      asset_id: 7,
    });
    // Money magnitudes that can exceed 2^53 are decimal strings on the wire.
    expect(typeof res.mark_px).toBe('string');
    expect(typeof res.open_interest).toBe('string');
  });

  it('marketInfoByCoin sends coin', async () => {
    const api = new InfoApi(BASE);
    nextType = 'market_info';
    nextData = { asset_id: 0, name: 'BTC' };
    await api.marketInfoByCoin('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'market_info',
      coin: 'BTC',
    });
  });

  it('markets returns the unwrapped array `data`', async () => {
    const api = new InfoApi(BASE);
    nextData = [{ asset_id: 0, name: 'BTC' }];
    const res = await api.markets();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'markets' });
    expect(Array.isArray(res)).toBe(true);
    expect(res[0]?.name).toBe('BTC');
  });

  it('vaultState is keyed by `vault` 0x address (NOT a numeric vault_id)', async () => {
    const api = new InfoApi(BASE);
    nextData = { vault: VAULT, name: 'vault:7' };
    await api.vaultState(VAULT);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'vault_state',
      vault: VAULT,
    });
  });

  it('stakingState is keyed by 0x address (NOT a numeric account_id)', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, total_staked: '0', delegations: [] };
    await api.stakingState(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'staking_state',
      address: ADDR,
    });
  });

  it('feeSchedule POSTs {"type":"fee_schedule"}', async () => {
    const api = new InfoApi(BASE);
    nextData = { tiers: [], builder_rebate_bps: '0', burn_ratio: '0.8' };
    await api.feeSchedule();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'fee_schedule' });
  });

  it('openOrders accepts an address ref', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, orders: [] };
    await api.openOrders({ address: ADDR });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'open_orders',
      address: ADDR,
    });
  });

  it('openOrders accepts a numeric account_id ref', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, account_id: 42, orders: [] };
    await api.openOrders({ account_id: 42 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'open_orders',
      account_id: 42,
    });
  });

  it('l2Book sends market_id (u32)', async () => {
    const api = new InfoApi(BASE);
    nextData = { market_id: 0, bids: [], asks: [] };
    await api.l2Book(0);
    expect(JSON.parse(captured!.body)).toEqual({ type: 'l2_book', market_id: 0 });
  });

  it('fundingHistory sends market_id (u32)', async () => {
    const api = new InfoApi(BASE);
    nextData = { market_id: 0, samples: [] };
    await api.fundingHistory(0);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'funding_history',
      market_id: 0,
    });
  });

  it('activeAssetData is keyed by address + asset_id', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      asset_id: 3,
      leverage: 10,
      margin_mode: 'cross',
      max_trade_size: '0',
      has_position: false,
    };
    await api.activeAssetData(ADDR, 3);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'active_asset_data',
      address: ADDR,
      asset_id: 3,
    });
  });

  it('maxBuilderFee is keyed by (address, builder)', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, builder: VAULT, max_fee_bps: 0, approved: false };
    await api.maxBuilderFee(ADDR, VAULT);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'max_builder_fee',
      address: ADDR,
      builder: VAULT,
    });
  });

  it('spotMeta POSTs {"type":"spot_meta"} and unwraps pairs + tokens', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      pairs: [
        {
          id: 101,
          name: 'BTC/USDC',
          base: 0,
          quote: 100,
          taker_fee_bps: 5,
          min_notional: '1000',
          active: true,
        },
      ],
      tokens: [
        { id: 0, name: 'BTC', sz_decimals: 5, wei_decimals: 8 },
        { id: 100, name: 'USDC', sz_decimals: 2, wei_decimals: 6 },
      ],
    };
    const res = await api.spotMeta();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'spot_meta' });
    // `name` is the derived `{base}/{quote}` display name; `id` is the
    // numeric pair id spot prints carry as `coin` on the WS feeds.
    expect(res.pairs[0]?.id).toBe(101);
    expect(res.pairs[0]?.name).toBe('BTC/USDC');
    expect(res.pairs[0]?.min_notional).toBe('1000');
    expect(res.tokens).toHaveLength(2);
    expect(res.tokens[0]?.name).toBe('BTC');
    expect(res.tokens[1]?.wei_decimals).toBe(6);
  });

  it('spotClearinghouseState is keyed by 0x address (NOT `user`)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      balances: [{ asset: 101, name: 'BTC/USDC', balance: '500' }],
    };
    const res = await api.spotClearinghouseState(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'spot_clearinghouse_state',
      address: ADDR,
    });
    expect(res.address).toBe(ADDR);
    expect(res.balances[0]?.asset).toBe(101);
    // `balance` is a decimal string (truncated toward zero) on the wire.
    expect(res.balances[0]?.balance).toBe('500');
  });

  it('webData2 is keyed by 0x address', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      clearinghouse: { account_value: '0', margin_used: '0', positions: [] },
      spot_balances: [],
      open_orders: [],
      vault_equities: [],
      exchange_status: {},
    };
    await api.webData2(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'web_data2',
      address: ADDR,
    });
  });

  it('raw passes an arbitrary typed body through and unwraps `data`', async () => {
    const api = new InfoApi(BASE);
    nextData = { ok: true };
    const res = await api.raw<{ ok: boolean }>({
      type: 'some_future_query',
      foo: 1,
    });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'some_future_query',
      foo: 1,
    });
    expect(res.ok).toBe(true);
  });

  it('rawEnvelope returns the full {type, data} envelope', async () => {
    const api = new InfoApi(BASE);
    nextType = 'liquidatable';
    nextData = { accounts: [] };
    const env = await api.rawEnvelope({ type: 'liquidatable' });
    expect(env.type).toBe('liquidatable');
    expect(env.data).toEqual({ accounts: [] });
  });
});

describe('InfoApi deployed-gateway read shapes', () => {
  it('marketInfo decodes lowercase kind + sz_decimals + mark/oracle px', async () => {
    const api = new InfoApi(BASE);
    nextType = 'market_info';
    nextData = {
      asset_id: 0,
      name: 'BTC',
      kind: 'perp',
      sz_decimals: 5,
      mark_px: '50000',
      oracle_px: '50000',
      tick_size: '1000000',
      step_size: '1',
      min_order: '1',
      max_leverage: 50,
      maint_margin_ratio: '300',
      init_margin_ratio: '200',
      funding: {
        rate_per_hr: '0',
        cap_per_hr: '0',
        interval_ms: 3600000,
        next_payment_ts: 0,
      },
      mark_source: 'MedianOfOraclesAndMid',
      fba_enabled: false,
      open_interest: '0',
    };
    const m = await api.marketInfo(0);
    expect(m.kind).toBe('perp');
    // sz_decimals is load-bearing for raw-lot size encoding.
    expect(m.sz_decimals).toBe(5);
    expect(typeof m.sz_decimals).toBe('number');
    expect(m.mark_px).toBe('50000');
    expect(m.oracle_px).toBe('50000');
  });

  it('feeSchedule decodes string bps + tiers[] + burn_ratio (optional top-level pair)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      maker_bps: '1.0',
      taker_bps: '5.0',
      referrer_share_bps: '5.0',
      builder_rebate_bps: '0',
      burn_ratio: '0.8',
      tiers: [{ maker_bps: '1.0', taker_bps: '5.0', volume_30d: '0' }],
    };
    const f = await api.feeSchedule();
    expect(f.maker_bps).toBe('1.0');
    expect(f.taker_bps).toBe('5.0');
    expect(f.burn_ratio).toBe('0.8');
    expect(f.referrer_share_bps).toBe('5.0');
    expect(f.builder_rebate_bps).toBe('0');
    expect(f.tiers[0]?.taker_bps).toBe('5.0');
    expect(f.tiers[0]?.volume_30d).toBe('0');

    // A source-built node may omit the top-level maker/taker pair.
    nextData = {
      referrer_share_bps: '5.0',
      builder_rebate_bps: '0',
      burn_ratio: '0.8',
      tiers: [{ maker_bps: '1.0', taker_bps: '5.0', volume_30d: '0' }],
    };
    const f2 = await api.feeSchedule();
    expect(f2.maker_bps).toBeUndefined();
    expect(f2.taker_bps).toBeUndefined();
  });

  it('openOrders decodes the live gateway oid:0 fixture (lowercase side, market_id key)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      orders: [
        {
          oid: 0,
          market_id: 0,
          side: 'bid',
          px: '2500000000000',
          size: '60',
          inserted_at_ms: 0,
        },
      ],
    };
    const o = await api.openOrders({ address: ADDR });
    expect(o.account_id).toBeUndefined();
    expect(o.orders[0]?.side).toBe('bid');
    expect(o.orders[0]?.px).toBe('2500000000000');
    expect(o.orders[0]?.size).toBe('60');
    // Live gateway gap: oid reads back as 0 (not cancellable by oid).
    expect(o.orders[0]?.oid).toBe(0);
  });
});

describe('InfoApi envelope validation', () => {
  it('throws when the response is not a {type, data} envelope', async () => {
    const api = new InfoApi(BASE);
    // Override the mock to return a bare (un-enveloped) body.
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ chain_id: 31337 }),
      }) as Response) as typeof fetch;
    await expect(api.nodeInfo()).rejects.toThrow(/envelope/);
  });

  it('throws when the echoed type does not match the request', async () => {
    const api = new InfoApi(BASE);
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ type: 'something_else', data: {} }),
      }) as Response) as typeof fetch;
    await expect(api.nodeInfo()).rejects.toThrow(/type mismatch/);
  });
});
