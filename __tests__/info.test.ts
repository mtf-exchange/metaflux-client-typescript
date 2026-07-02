// MTF-native /info request-shape + envelope-unwrap tests — pure TS, no WASM.
// Mocks global fetch and asserts each InfoApi method POSTs the EXACT
// `{"type": ...}` body the server's `/info` dispatcher expects
// (per the KB spec metaflux-knowledges/api/rest/info.md), keyed by the real
// param (`coin` market symbol / 0x `address` / 0x `vault`), and that the
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

  it('marketInfo is keyed by coin SYMBOL (NOT asset_id)', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC', asset_id: 0, mark_px: '0', open_interest: '0' };
    const res = await api.marketInfo('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'market_info',
      coin: 'BTC',
    });
    // Money magnitudes that can exceed 2^53 are decimal strings on the wire.
    expect(typeof res.mark_px).toBe('string');
    expect(typeof res.open_interest).toBe('string');
  });

  it('markets returns the {perp, spot} universe object', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      perp: [{ coin: 'BTC', asset_id: 0 }],
      spot: { pairs: [], tokens: [] },
    };
    const res = await api.markets();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'markets' });
    expect(Array.isArray(res.perp)).toBe(true);
    expect(res.perp[0]?.coin).toBe('BTC');
    expect(res.spot.pairs).toEqual([]);
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

  it('openOrders is keyed by 0x address only (account_id param is GONE)', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, orders: [] };
    await api.openOrders(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'open_orders',
      address: ADDR,
    });
  });

  it('l2Book is keyed by coin SYMBOL (market_id param is GONE)', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC', bids: [], asks: [] };
    const res = await api.l2Book('BTC');
    expect(JSON.parse(captured!.body)).toEqual({ type: 'l2_book', coin: 'BTC' });
    expect(res.coin).toBe('BTC');
  });

  it('recentTrades is keyed by coin; limit rides ONLY when provided', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC', last_trade_ms: 0, trades: [] };
    await api.recentTrades('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'recent_trades',
      coin: 'BTC',
    });
    await api.recentTrades('BTC', 50);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'recent_trades',
      coin: 'BTC',
      limit: 50,
    });
  });

  it('tradesByTime sends coin + start_time/end_time ONLY when provided', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC', start_time: null, end_time: null, trades: [] };
    await api.tradesByTime('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'trades_by_time',
      coin: 'BTC',
    });
    await api.tradesByTime('BTC', 1_700_000_000_000, 1_700_000_999_999);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'trades_by_time',
      coin: 'BTC',
      start_time: 1_700_000_000_000,
      end_time: 1_700_000_999_999,
    });
  });

  it('tradesByTime decodes symbol-keyed trade records', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      coin: 'BTC',
      start_time: 1_700_000_000_000,
      end_time: null,
      trades: [
        {
          coin: 'BTC',
          side: 'A',
          px: '61643.70000000',
          sz: '0.00024',
          time: 1_700_000_000_555,
          tid: 1234567890,
          block: 38997,
          hash: '0x4660d9ccf52ef1abde5e03d1b3f1c110b948d2f71331f086239666781dbde91c',
        },
      ],
    };
    const res = await api.tradesByTime('BTC', 1_700_000_000_000);
    expect(res.trades[0]?.coin).toBe('BTC');
    expect(res.trades[0]?.side).toBe('A');
    expect(typeof res.trades[0]?.px).toBe('string');
    expect(typeof res.trades[0]?.tid).toBe('number');
    expect(res.end_time).toBeNull();
  });

  it('userFills is keyed by 0x address only', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, fills: [] };
    await api.userFills(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_fills',
      address: ADDR,
    });
  });

  it('userFillsByTime sends address + optional window bounds', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, start_time: 5, end_time: null, fills: [] };
    await api.userFillsByTime(ADDR, 5);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_fills_by_time',
      address: ADDR,
      start_time: 5,
    });
  });

  it('fundingHistory is keyed by coin and carries premium + funding_rate', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      coin: 'BTC',
      samples: [{ ts_ms: 1, premium: '0.0057', funding_rate: '0.0057' }],
    };
    const res = await api.fundingHistory('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'funding_history',
      coin: 'BTC',
    });
    expect(res.samples[0]?.premium).toBe('0.0057');
    expect(res.samples[0]?.funding_rate).toBe('0.0057');
  });

  it('predictedFundings unwraps the per-market array', async () => {
    const api = new InfoApi(BASE);
    nextData = [
      { coin: 'BTC', predicted_rate: '0.0037', next_funding_time: 1_783_011_600_000 },
    ];
    const res = await api.predictedFundings();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'predicted_fundings' });
    expect(res[0]?.coin).toBe('BTC');
    // Clamped, actually-charged rate as a decimal string; boundary is ms.
    expect(typeof res[0]?.predicted_rate).toBe('string');
    expect(typeof res[0]?.next_funding_time).toBe('number');
  });

  it('candleSnapshot is keyed by coin + interval (the single candle query)', async () => {
    const api = new InfoApi(BASE);
    nextData = { candles: [] };
    await api.candleSnapshot('BTC', '1m');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'candle_snapshot',
      coin: 'BTC',
      interval: '1m',
    });
  });

  it('candleSnapshot includes start_time/end_time ONLY when provided', async () => {
    const api = new InfoApi(BASE);
    nextData = { candles: [] };
    await api.candleSnapshot('BTC', '1m', 1_700_000_000_000);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'candle_snapshot',
      coin: 'BTC',
      interval: '1m',
      start_time: 1_700_000_000_000,
    });
    await api.candleSnapshot('BTC', '1m', 1_700_000_000_000, 1_700_000_999_999);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'candle_snapshot',
      coin: 'BTC',
      interval: '1m',
      start_time: 1_700_000_000_000,
      end_time: 1_700_000_999_999,
    });
  });

  it('candleSnapshot decodes the compact bar shape', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      candles: [
        {
          t: 1_700_000_040_000,
          T: 1_700_000_099_999,
          s: 'BTC',
          i: '1m',
          o: '67000.00',
          c: '67042.50',
          h: '67080.00',
          l: '66990.00',
          v: '12.5',
          q: '837843.75',
          n: 37,
        },
      ],
    };
    const res = await api.candleSnapshot('BTC', '1m');
    expect(res.candles).toHaveLength(1);
    const bar = res.candles[0]!;
    expect(bar.s).toBe('BTC');
    expect(bar.i).toBe('1m');
    expect(bar.c).toBe('67042.50');
    // OHLC / volumes are decimal strings; times + count are JSON numbers.
    expect(typeof bar.o).toBe('string');
    expect(typeof bar.v).toBe('string');
    expect(typeof bar.q).toBe('string');
    expect(typeof bar.n).toBe('number');
    expect(bar.t).toBe(1_700_000_040_000);
  });

  it('agents / subAccounts are keyed by 0x address only', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, agents: [] };
    await api.agents(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({ type: 'agents', address: ADDR });
    nextData = { address: ADDR, sub_accounts: [] };
    await api.subAccounts(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'sub_accounts',
      address: ADDR,
    });
  });

  it('activeAssetData is keyed by address + coin SYMBOL', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      coin: 'BTC',
      leverage: 10,
      margin_mode: 'cross',
      mark_px: '61589.39',
      available_to_trade: ['500000000', '500000000'],
      max_trade_szs: ['8118.28099', '8118.28099'],
      max_trade_size: '0',
      has_position: false,
    };
    const res = await api.activeAssetData(ADDR, 'BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'active_asset_data',
      address: ADDR,
      coin: 'BTC',
    });
    expect(res.available_to_trade).toHaveLength(2);
    expect(res.max_trade_szs).toHaveLength(2);
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
          id: 110,
          name: 'BTC/USDC',
          base: 101,
          quote: 100,
          taker_fee_bps: '5',
          min_notional: '1',
          active: true,
          mark_px: '50000',
          mid_px: '50000',
          prev_day_px: null,
          day_ntl_vlm: '0',
          circulating_supply: '0',
        },
      ],
      tokens: [
        {
          id: 100,
          name: 'USDC',
          sz_decimals: 2,
          wei_decimals: 6,
          evm_contract: null,
          is_canonical: true,
          system_address: '0x80abd3bd8c42d2a279e4fa00f20bb30637734371',
          token_id: '0xf23ea17597e324c04f842e6d8bfffe75636f0af88e7c7ab93ea755d9056396bc',
        },
      ],
    };
    const res = await api.spotMeta();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'spot_meta' });
    // `name` is the derived `{base}/{quote}` display name; `id` is the
    // numeric pair id spot prints carry as `coin` on the WS feeds.
    expect(res.pairs[0]?.id).toBe(110);
    expect(res.pairs[0]?.name).toBe('BTC/USDC');
    // taker_fee_bps is a decimal STRING on this surface.
    expect(res.pairs[0]?.taker_fee_bps).toBe('5');
    expect(res.tokens[0]?.wei_decimals).toBe(6);
    expect(res.tokens[0]?.is_canonical).toBe(true);
  });

  it('spotClearinghouseState is keyed by 0x address (NOT `user`)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      balances: [{ asset: 101, name: 'BTC', total: '500', hold: '10' }],
    };
    const res = await api.spotClearinghouseState(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'spot_clearinghouse_state',
      address: ADDR,
    });
    expect(res.address).toBe(ADDR);
    expect(res.balances[0]?.asset).toBe(101);
    // total/hold are decimal strings on the wire.
    expect(res.balances[0]?.total).toBe('500');
    expect(res.balances[0]?.hold).toBe('10');
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
  it('marketInfo decodes coin key + margin_tiers ladder', async () => {
    const api = new InfoApi(BASE);
    nextType = 'market_info';
    nextData = {
      coin: 'BTC',
      asset_id: 0,
      kind: 'perp',
      sz_decimals: 5,
      mark_px: '61443.6',
      oracle_px: '61286.1',
      mid_px: null,
      prev_day_px: '61276',
      change_24h: '0.00273516',
      day_ntl_vlm: '3772.890084',
      premium: '0.0058341',
      tick_size: '0.1',
      step_size: '0.00001',
      min_order: '0.00001',
      max_leverage: 50,
      maint_margin_ratio: '1320',
      init_margin_ratio: '200',
      margin_tiers: [
        { max_open_interest: '100000', max_leverage: 50, maint_margin_ratio: '100' },
        { max_open_interest: '500000', max_leverage: 20, maint_margin_ratio: '250' },
        { max_open_interest: null, max_leverage: 5, maint_margin_ratio: '1000' },
      ],
      funding: {
        rate_per_hr: '58',
        cap_per_hr: '1120',
        interval_ms: 3600000,
        next_payment_ts: 1783011600000,
      },
      mark_source: 'oracle_median',
      fba_enabled: false,
      open_interest: '0.02346',
      disable_open: false,
      disable_close: false,
      halted: false,
      strict_isolated: false,
    };
    const m = await api.marketInfo('BTC');
    expect(m.coin).toBe('BTC');
    // sz_decimals is load-bearing for raw-lot size encoding.
    expect(m.sz_decimals).toBe(5);
    // margin_tiers: upper-bound bands, null = unbounded top band.
    expect(m.margin_tiers).toHaveLength(3);
    expect(m.margin_tiers[0]?.max_open_interest).toBe('100000');
    expect(m.margin_tiers[2]?.max_open_interest).toBeNull();
    expect(m.margin_tiers[0]?.max_leverage).toBe(50);
    // maint_margin_ratio bands are bps STRINGS.
    expect(m.margin_tiers[0]?.maint_margin_ratio).toBe('100');
    expect(m.mid_px).toBeNull();
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

  it('openOrders decodes coin-keyed rows (lowercase side, cloid nullable)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      orders: [
        {
          oid: 12345,
          coin: 'BTC',
          side: 'bid',
          px: '25000',
          size: '60',
          cloid: null,
          inserted_at_ms: 1_700_000_000_000,
        },
      ],
    };
    const o = await api.openOrders(ADDR);
    expect(o.orders[0]?.coin).toBe('BTC');
    expect(o.orders[0]?.side).toBe('bid');
    expect(o.orders[0]?.px).toBe('25000');
    expect(o.orders[0]?.oid).toBe(12345);
    expect(o.orders[0]?.cloid).toBeNull();
  });

  it('userFills decodes the committed fill-ring record shape', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      fills: [
        {
          coin: 0,
          side: 'B',
          px: '67042.50',
          sz: '0.125',
          time: 1_700_000_000_555,
          oid: 12345,
          tid: 90123,
          fee: '4.19',
          closed_pnl: '0',
          dir: 'Open Long',
          start_position: '0',
          block: 562,
          hash: '0x2315b79b9e82c2deb279a59448bf7841f3767d30d874e5b544d75bb9fd1e9b0c',
        },
      ],
    };
    const res = await api.userFills(ADDR);
    const f = res.fills[0]!;
    // Fill rings render the NUMERIC asset id (unlike the symbol-keyed tape).
    expect(f.coin).toBe(0);
    expect(f.side).toBe('B');
    expect(f.dir).toBe('Open Long');
    expect(typeof f.fee).toBe('string');
    expect(typeof f.closed_pnl).toBe('string');
    expect(f.tid).toBe(90123);
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
