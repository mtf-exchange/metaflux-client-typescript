// MTF-native /info request-shape + envelope-unwrap tests — pure TS, no WASM.
// Mocks global fetch and asserts each InfoApi method POSTs the EXACT
// `{"type": ...}` body the server's `/info` dispatcher expects
// (per the KB spec metaflux-knowledges/api/rest/info.md), keyed by the real
// param (`coin` market symbol / 0x `address` / 0x `vault`), and that the
// `{data}` envelope is unwrapped to the typed `data`, whose `type` key the
// unwrap validates.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InfoApi } from '../src/rest/info.js';
import { MetaFluxApiError } from '../src/rest/http.js';

interface Captured {
  url: string;
  method: string;
  body: string;
  contentType: string | null;
}

let captured: Captured | undefined;
// Server response — every `/info` reply is the `{data}` envelope, with the
// `type` discriminator folded INTO `data`. Tests set `nextType` + `nextData`;
// the mock fetch wraps them.
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
        JSON.stringify({
          data: { ...(nextData as object), type: nextType || reqType },
        }),
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
  it('accountState is keyed by 0x address (NOT a numeric account_id)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      account_value: '0',
      clearinghouse_state: { '': { positions: [] } },
      balances: [],
    };
    await api.accountState(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'account_state',
      address: ADDR,
    });
  });

  it('accountOverview posts account_state detail:overview and unwraps every facet', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      vault: { equities: [], vaults: [] },
      staking: {
        state: { total_staked: '0', delegations: [], pending_unstakes: [] },
        summary: {
          total_delegated: '0',
          pending_withdrawal: '0',
          claimable_rewards: '0',
          n_delegations: 0,
        },
      },
      sub_accounts: [],
      multisig: { is_multi_sig: false, threshold: 0, signers: [] },
      agents: [{ agent: ADDR, name: 'bot', expires_at: 1_784_800_000_000 }],
      height: 8_416_000,
      time: 1_784_820_001_000,
    };
    const res = await api.accountOverview(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'account_state',
      address: ADDR,
      detail: 'overview',
    });
    // Each nested facet drops its own `address`; the snapshot carries it once.
    expect(res.address).toBe(ADDR);
    expect(res.staking.summary.n_delegations).toBe(0);
    // `height` / `time` are FLAT at the top level, not nested under `as_of`.
    expect(res.height).toBe(8_416_000);
    expect(res.time).toBe(1_784_820_001_000);
    expect(res.agents[0]?.expires_at).toBe(1_784_800_000_000);
  });

  it('markets narrows to one market by coin SYMBOL, same shape', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      perp: [{ coin: 'BTC', mark_px: '0', open_interest: '0' }],
      spot: { pairs: [], tokens: [] },
    };
    const res = await api.markets('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'markets',
      coin: 'BTC',
    });
    // A `coin` filter narrows the rows; it does NOT change the shape.
    expect(res.perp).toHaveLength(1);
    // Money magnitudes that can exceed 2^53 are decimal strings on the wire.
    expect(typeof res.perp[0]?.mark_px).toBe('string');
    expect(typeof res.perp[0]?.open_interest).toBe('string');
  });

  it('markets omits `coin` entirely when no filter is asked for', async () => {
    const api = new InfoApi(BASE);
    nextData = { perp: [], spot: { pairs: [], tokens: [] } };
    await api.markets();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'markets' });
  });

  it('markets returns the DYNAMIC {perp, spot} universe object', async () => {
    const api = new InfoApi(BASE);
    // The row chain 114514 served on 2026-08-08. It carries NO precision grid,
    // NO leverage ladder and NO trade-control flag -- those live on
    // `markets_meta`. Typing this row as the union made `open` / `sz_decimals`
    // read `undefined` while the type promised a value.
    nextData = {
      perp: [
        {
          change_24h: '0.01186283',
          coin: 'BTC',
          day_ntl_vlm: '0',
          funding: {
            cap_per_hr: '400',
            interval_ms: 3600000,
            next_payment_ts: 1786165200000,
            rate_per_hr: '-3',
          },
          halted: false,
          impact_pxs: ['64998', '65030.7'],
          kind: 'perp',
          mark_px: '65013.3',
          mid_px: '65014.4',
          open_interest: '0.7895',
          oracle_px: '65033.7',
          premium: '-0.00029993',
          prev_day_px: '64251.1',
        },
      ],
      spot: { pairs: [], tokens: [] },
    };
    const res = await api.markets();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'markets' });
    expect(Array.isArray(res.perp)).toBe(true);
    expect(res.perp[0]?.coin).toBe('BTC');
    expect(res.perp[0]?.mark_px).toBe('65013.3');
    expect(res.perp[0]?.halted).toBe(false);
    expect(res.perp[0]?.impact_pxs).toEqual(['64998', '65030.7']);
    // A healthy market omits both markers; neither may read as a value.
    expect(res.perp[0]?.px_stale).toBeUndefined();
    expect(res.perp[0]?.day_ntl_vlm_lower_bound_from).toBeUndefined();
    expect(res.spot.pairs).toEqual([]);
  });

  it('marketsMeta decodes an optional perp `token` block + spot object evm_contract', async () => {
    const api = new InfoApi(BASE);
    nextType = 'markets_meta';
    nextData = {
      perp: [
        {
          coin: 'BTC',
          asset_id: 0,
          kind: 'perp',
          sz_decimals: 5,
          // The optional underlying-token block (omitted when unregistered).
          token: {
            id: 101,
            wei_decimals: 8,
            token_id:
              '0xf23ea17597e324c04f842e6d8bfffe75636f0af88e7c7ab93ea755d9056396bc',
            system_address: '0x80abd3bd8c42d2a279e4fa00f20bb30637734371',
            evm_contract: {
              address: '0x2222222222222222222222222222222222222222',
              evm_extra_wei_decimals: 0,
            },
            is_canonical: true,
            circulating_supply: '0',
          },
        },
        // A perp with NO registered underlying token omits `token` entirely.
        { coin: 'ETH', asset_id: 1, kind: 'perp', sz_decimals: 4 },
      ],
      spot: { pairs: [], tokens: [] },
    };
    const res = await api.marketsMeta();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'markets_meta' });
    const btc = res.perp[0]!;
    expect(btc.token?.id).toBe(101);
    // Issuance on a perp token block is `circulating_supply` (NOT total_supply).
    expect(btc.token?.circulating_supply).toBe('0');
    expect(btc.token?.evm_contract?.address).toBe(
      '0x2222222222222222222222222222222222222222',
    );
    // A perp with no underlying token has `token` undefined.
    expect(res.perp[1]!.token).toBeUndefined();
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

  it('feeSchedule(address) adds the address and decodes per-product rows', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      tiers: [],
      builder_rebate_bps: '0',
      burn_ratio: '0.8',
      referrer_share_bps: '5.0',
      user: {
        address: ADDR,
        taker_volume_30d: '12500000',
        maker_volume_30d: '3100000',
        taker_bps: '4.5',
        maker_bps: '1.5',
        effective_taker_bps: '4.05',
        effective_maker_bps: '1.2',
        staking_discount_permille: 100,
        maker_rebate_bps: '0.3',
        products: [
          {
            product: 'perp',
            taker_bps: '4.05',
            maker_bps: '1.2',
            taker_volume_30d: '12500000',
            maker_volume_30d: '3100000',
          },
          { product: 'spot_margin', taker_bps: '9.0', taker_volume_30d: '0' },
          {
            product: 'option',
            option_taker_bps: '0.5',
            option_premium_cap_ppm: 150000,
          },
        ],
      },
    };
    const f = await api.feeSchedule(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'fee_schedule',
      address: ADDR,
    });
    expect(f.user?.staking_discount_permille).toBe(100);
    // The four products price apart, so the row is the rate — not the top pair.
    expect(f.user?.products?.[1]?.product).toBe('spot_margin');
    // A row with no maker leg OMITS both maker keys. `undefined` is "no maker
    // leg", which is NOT the same fact as a maker rate of zero.
    expect(f.user?.products?.[1]?.maker_bps).toBeUndefined();
    expect(f.user?.products?.[1]?.maker_volume_30d).toBeUndefined();
    // A NEGATIVE maker rate is a credit paid to the maker, not a malformed rate.
    expect(f.user?.products?.[0]?.maker_bps).toBe('1.2');
    // The option row is a DIFFERENT shape: no ladder tier, no volume, and the
    // two rates that actually decide its fee.
    expect(f.user?.products?.[2]?.taker_bps).toBeUndefined();
    expect(f.user?.products?.[2]?.taker_volume_30d).toBeUndefined();
    expect(f.user?.products?.[2]?.option_premium_cap_ppm).toBe(150000);
  });

  it('feeSchedule tolerates an absent user block and absent products', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      tiers: [],
      builder_rebate_bps: '0',
      burn_ratio: '0.8',
      referrer_share_bps: '5.0',
    };
    const bare = await api.feeSchedule();
    expect(bare.user).toBeUndefined();
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

  it('l2Book accepts a spot pair name + omits aggregation params when absent', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC/USDC', bids: [], asks: [] };
    const res = await api.l2Book('BTC/USDC');
    // No params object → the body carries only type + coin.
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'l2_book',
      coin: 'BTC/USDC',
    });
    expect(res.coin).toBe('BTC/USDC');
  });

  it('l2Book serializes aggregation params to snake_case, only when defined', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC', bids: [], asks: [] };
    await api.l2Book('BTC', { nSigFigs: 5, mantissa: 2, nLevels: 20 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'l2_book',
      coin: 'BTC',
      n_sig_figs: 5,
      mantissa: 2,
      n_levels: 20,
    });
    // A partial params object sends only the defined fields (no unpaired
    // mantissa — the gateway would reject it).
    await api.l2Book('BTC', { nSigFigs: 3 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'l2_book',
      coin: 'BTC',
      n_sig_figs: 3,
    });
  });

  it('trades is keyed by coin; limit and window ride ONLY when provided', async () => {
    const api = new InfoApi(BASE);
    nextData = { coin: 'BTC', last_trade: 0, start_time: null, end_time: null, trades: [] };
    // Un-ranged: the recent ring, and nothing but `coin` on the wire.
    await api.trades('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'trades',
      coin: 'BTC',
    });
    await api.trades('BTC', { limit: 50 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'trades',
      coin: 'BTC',
      limit: 50,
    });
    // Ranged: the window makes it an archive-reaching ask.
    await api.trades('BTC', {
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_999_999,
    });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'trades',
      coin: 'BTC',
      start_time: 1_700_000_000_000,
      end_time: 1_700_000_999_999,
    });
  });

  it('trades decodes symbol-keyed trade records', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      coin: 'BTC',
      last_trade: 1_700_000_000_555,
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
    const res = await api.trades('BTC', { startTime: 1_700_000_000_000 });
    expect(res.trades[0]?.coin).toBe('BTC');
    expect(res.trades[0]?.side).toBe('A');
    expect(typeof res.trades[0]?.px).toBe('string');
    expect(typeof res.trades[0]?.tid).toBe('number');
    expect(res.end_time).toBeNull();
  });

  it('userFills is keyed by 0x address only', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, start_time: null, end_time: null, fills: [] };
    await api.userFills(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_fills',
      address: ADDR,
    });
  });

  it('userFills sends the window bounds ONLY when provided', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, start_time: 5, end_time: null, fills: [] };
    await api.userFills(ADDR, { startTime: 5 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_fills',
      address: ADDR,
      start_time: 5,
    });
  });

  it('userPositionHistory returns the fills-style {address, positions} envelope', async () => {
    const api = new InfoApi(BASE);
    // The degraded row chain 114514 served on 2026-08-08. There is NO
    // account-wide `coverage` object: the per-row flags are the whole report.
    nextData = {
      address: ADDR,
      positions: [
        {
          avg_close_px: '74.75000000',
          avg_entry_px: null,
          close_block: 6_831_775,
          close_complete: false,
          closed_at: 1_786_162_051_867,
          closed_pnl: '0.8960000000',
          closed_sz: '0.80',
          coin: 'SOL',
          entry_complete: false,
          fee_paid: '0.001794',
          funding_complete: false,
          funding_paid: '0',
          max_sz: null,
          net_pnl: '0.8942060000',
          open_block: 6_831_775,
          opened_at: 1_786_162_051_867,
          realized_pnl: '0.8942060000',
          side: 'long',
        },
      ],
    };
    const res = await api.userPositionHistory(ADDR, 2);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_position_history',
      address: ADDR,
      limit: 2,
    });
    const p = res.positions[0]!;
    expect(p.coin).toBe('SOL');
    expect(p.side).toBe('long');
    expect(p.closed_sz).toBe('0.80');
    // A degraded row reports itself and nulls what it cannot stand behind.
    expect(p.entry_complete).toBe(false);
    expect(p.avg_entry_px).toBeNull();
    expect(p.max_sz).toBeNull();
    // funding_paid reads "0" while funding_complete is false: UNKNOWN, not zero.
    expect(p.funding_paid).toBe('0');
    expect(p.funding_complete).toBe(false);
    // The payload carries address + positions and nothing else; `type` is the
    // envelope's discriminator, folded in beside them.
    expect(Object.keys(res).sort()).toEqual(['address', 'positions', 'type']);
  });

  it('userPositionHistoryByTime sends the window and gets no echo back', async () => {
    const api = new InfoApi(BASE);
    nextType = 'user_position_history_by_time';
    nextData = { address: ADDR, positions: [] };
    const res = await api.userPositionHistoryByTime(ADDR, 5, 9);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_position_history_by_time',
      address: ADDR,
      start_time: 5,
      end_time: 9,
    });
    // Unlike userFillsByTime, this reply does NOT echo the bounds.
    expect(Object.keys(res).sort()).toEqual(['address', 'positions', 'type']);
  });

  it('fundingHistory is keyed by coin and carries premium + funding_rate', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      coin: 'BTC',
      samples: [{ ts: 1, premium: '0.0057', funding_rate: '0.0057' }],
    };
    const res = await api.fundingHistory('BTC');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'funding_history',
      coin: 'BTC',
    });
    expect(res.samples[0]?.ts).toBe(1);
    expect(res.samples[0]?.premium).toBe('0.0057');
    expect(res.samples[0]?.funding_rate).toBe('0.0057');
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

  // `candle_type` picks the price series. Omitting it takes the node's `mark`
  // default, so the request bytes stay identical for a caller that never asks.
  it('candleSnapshot OMITS candle_type unless asked', async () => {
    const api = new InfoApi(BASE);
    nextData = { candles: [] };
    await api.candleSnapshot('BTC', '1m');
    expect(JSON.parse(captured!.body)).not.toHaveProperty('candle_type');
  });

  it('candleSnapshot sends candle_type when given', async () => {
    const api = new InfoApi(BASE);
    nextData = { candles: [] };
    await api.candleSnapshot('BTC', '1m', undefined, undefined, 'oracle');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'candle_snapshot',
      coin: 'BTC',
      interval: '1m',
      candle_type: 'oracle',
    });
    await api.candleSnapshot('BTC', '1m', 1_700_000_000_000, undefined, 'mark');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'candle_snapshot',
      coin: 'BTC',
      interval: '1m',
      start_time: 1_700_000_000_000,
      candle_type: 'mark',
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

  // A bar folds a PRICE series, not executions: `v` / `q` are always "0" and
  // `n` counts samples. Pinning the fixture stops the retired trade-candle
  // shape creeping back in.
  it('candleSnapshot decodes the compact PRICE bar shape', async () => {
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
          v: '0',
          q: '0',
          n: 12,
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
    expect(bar.v).toBe('0');
    expect(bar.q).toBe('0');
    expect(bar.n).toBe(12);
    expect(bar.t).toBe(1_700_000_040_000);
  });

  it('the agents and sub-accounts facets ride accountOverview', async () => {
    const api = new InfoApi(BASE) as unknown as Record<string, unknown>;
    // Each was a strict subset of the aggregate, so each merged into it. A
    // stale method here would make an unreachable call look reachable.
    expect(api.agents).toBeUndefined();
    expect(api.subAccounts).toBeUndefined();
    expect(api.userToMultiSigSigners).toBeUndefined();
    expect(api.userVaultEquities).toBeUndefined();
    expect(api.delegatorSummary).toBeUndefined();
    expect(api.userRole).toBeUndefined();
    expect(api.webData).toBeUndefined();
    expect(typeof api.accountOverview).toBe('function');
  });

  it('drops every read the surface cut removed', () => {
    const api = new InfoApi(BASE) as unknown as Record<string, unknown>;
    for (const gone of [
      'marketInfo',
      'recentTrades',
      'tradesByTime',
      'userFillsByTime',
      'predictedFundings',
      'spotClearinghouseState',
      'maxMarketOrderNtls',
      'perpsAtOpenInterestCap',
      'leadingVaults',
      'maxBuilderFee',
      'spotDeployState',
      // Deleted outright: no lane serves them.
      'nodeInfo',
      'blockInfo',
      'protocolMetrics',
      // Operator lane: refused on the public API.
      'rfqOpen',
      'rfqUser',
      'fbaBatchState',
      'mip3DeployerOracle',
    ]) {
      expect(api[gone]).toBeUndefined();
    }
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

  it('spotMeta re-routes to markets_meta kind=spot and unwraps its `spot`', async () => {
    const api = new InfoApi(BASE);
    // The standalone `spot_meta` /info type was removed server-side; the
    // wrapper now fetches `markets_meta` (kind=spot) whose data RETAINS the
    // `{spot: {...}}` wrapper key, and unwraps it.
    nextData = {
      spot: {
        pairs: [
          {
            id: 110,
            name: 'BTC/USDC',
            base: 101,
            quote: 100,
            taker_fee_bps: '5',
            min_notional: '1',
            active: true,
            // The pair carries the BASE token's size precision.
            sz_decimals: 5,
            mark_px: '50000',
            mid_px: '50000',
            prev_day_px: null,
            day_ntl_vlm: '0',
            circulating_supply: '0',
          },
        ],
        tokens: [
          {
            id: 101,
            name: 'BTC',
            sz_decimals: 5,
            wei_decimals: 8,
            // evm_contract is an OBJECT now, not a bare 0x string.
            evm_contract: {
              address: '0x2222222222222222222222222222222222222222',
              evm_extra_wei_decimals: 0,
              variant: 2,
            },
            is_canonical: true,
            system_address: '0x80abd3bd8c42d2a279e4fa00f20bb30637734371',
            token_id:
              '0xf23ea17597e324c04f842e6d8bfffe75636f0af88e7c7ab93ea755d9056396bc',
            total_supply: '21000000',
          },
        ],
      },
    };
    const res = await api.spotMeta();
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'markets_meta',
      kind: 'spot',
    });
    // `name` is the derived `{base}/{quote}` display name; `id` is the
    // numeric pair id spot prints carry as `coin` on the WS feeds.
    expect(res.pairs[0]?.id).toBe(110);
    expect(res.pairs[0]?.name).toBe('BTC/USDC');
    // taker_fee_bps is a decimal STRING on this surface.
    expect(res.pairs[0]?.taker_fee_bps).toBe('5');
    expect(res.tokens[0]?.wei_decimals).toBe(8);
    expect(res.tokens[0]?.is_canonical).toBe(true);
    // `variant` folds in from the retired `evm_contract_bindings` read.
    expect(res.tokens[0]?.evm_contract?.variant).toBe(2);
    // evm_contract is the {address, evm_extra_wei_decimals, variant} object.
    expect(res.tokens[0]?.evm_contract?.address).toBe(
      '0x2222222222222222222222222222222222222222',
    );
    expect(res.tokens[0]?.evm_contract?.evm_extra_wei_decimals).toBe(0);
    // spot token rows carry total_supply (perp `token` blocks carry
    // circulating_supply instead — distinct key).
    expect(res.tokens[0]?.total_supply).toBe('21000000');
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

  it('raw returns the `type` folded into data alongside the payload', async () => {
    const api = new InfoApi(BASE);
    nextData = { accepting_orders: true };
    const res = await api.raw<{ type: string; accepting_orders: boolean }>({
      type: 'exchange_status',
    });
    expect(res.type).toBe('exchange_status');
    expect(res.accepting_orders).toBe(true);
  });
});

describe('InfoApi deployed-gateway read shapes', () => {
  it('marketsMeta decodes coin key + margin_tiers ladder + signing_id', async () => {
    const api = new InfoApi(BASE);
    nextType = 'markets_meta';
    nextData = {
      perp: [{
      coin: 'BTC',
      signing_id: 0,
      kind: 'perp',
      sz_decimals: 5,
      mark_px: '61443.6',
      oracle_px: '61286.1',
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
      open: true,
      close: true,
      strict_isolated: false,
      risk_override: null,
      }],
      spot: { pairs: [], tokens: [] },
    };
    const m = (await api.marketsMeta('BTC')).perp[0]!;
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
    // The write handle is the ONE number on the read plane.
    expect(m.signing_id).toBe(0);
    // `null` means NO override; an object with no keys would mean an override
    // record that overrides nothing. The two are different facts.
    expect(m.risk_override).toBeNull();
    // Uncapped OI omits the key; an absent cap is not a cap of zero.
    expect(m.oi_cap).toBeUndefined();
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

  it('openOrders decodes the canonical row (side B/A, sz, inserted_at)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      orders: [
        {
          oid: 12345,
          coin: 'BTC',
          side: 'B',
          px: '25000',
          sz: '60',
          orig_sz: null,
          cloid: null,
          tif: 'gtc',
          reduce_only: false,
          trigger: null,
          inserted_at: 1_700_000_000_000,
        },
      ],
    };
    const o = await api.openOrders(ADDR);
    const row = o.orders[0]!;
    expect(row.coin).toBe('BTC');
    expect(row.side).toBe('B');
    expect(row.px).toBe('25000');
    expect(row.sz).toBe('60');
    expect(row.oid).toBe(12345);
    expect(row.cloid).toBeNull();
    expect(row.tif).toBe('gtc');
    expect(row.reduce_only).toBe(false);
    expect(row.trigger).toBeNull();
    expect(row.inserted_at).toBe(1_700_000_000_000);
  });

  it('openOrders carries a parked trigger row (tif "trigger" + trigger block)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      orders: [
        {
          oid: 777,
          coin: 'MTF/USDC',
          side: 'A',
          px: null,
          sz: '5',
          orig_sz: null,
          cloid: null,
          tif: 'trigger',
          reduce_only: true,
          trigger: {
            trigger_px: '0.11',
            trigger_above: false,
            is_parked: true,
            is_market: false,
            limit_px: '0.10',
          },
          inserted_at: 1_700_000_000_000,
        },
      ],
    };
    const o = await api.openOrders(ADDR);
    const row = o.orders[0]!;
    // A parked row rides the SAME kind the removed `frontend_open_orders`
    // used to serve, so `tif` must accept the non-TIF token "trigger".
    expect(row.tif).toBe('trigger');
    expect(row.coin).toBe('MTF/USDC');
    expect(row.trigger?.is_parked).toBe(true);
    expect(row.trigger?.is_market).toBe(false);
    expect(row.trigger?.limit_px).toBe('0.10');
    // An ordinary trigger owns neither key, so both must stay absent.
    expect(row.trigger?.group).toBeUndefined();
    expect(row.trigger?.trail_px).toBeUndefined();
  });

  it('openOrders reads the ladder handle and the trailing callback', async () => {
    const api = new InfoApi(BASE);
    const leg = (oid: number, extra: Record<string, unknown>) => ({
      oid,
      coin: 'MTF',
      side: 'A',
      px: '0.11',
      sz: '5',
      orig_sz: null,
      cloid: null,
      tif: 'trigger',
      reduce_only: true,
      trigger: {
        trigger_px: '0.11',
        trigger_above: false,
        is_parked: true,
        is_market: true,
        limit_px: null,
        ...extra,
      },
      inserted_at: oid,
    });
    nextData = {
      address: ADDR,
      orders: [
        leg(21, { group: 21 }),
        leg(22, { group: 21 }),
        leg(23, { group: 21, trail_px: '0.005' }),
      ],
    };
    const o = await api.openOrders(ADDR);
    // Every leg of one ladder shares the handle of its first leg.
    expect(o.orders.map((r) => r.trigger?.group)).toEqual([21, 21, 21]);
    expect(o.orders[0]!.trigger?.trail_px).toBeUndefined();
    expect(o.orders[2]!.trigger?.trail_px).toBe('0.005');
  });

  it('l2Book levels carry `sz`, not `size`', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      coin: 'BTC',
      bids: [{ px: '25000', sz: '1.5', n_orders: 2 }],
      asks: [{ px: '25001', sz: '0.75', n_orders: 1 }],
    };
    const b = await api.l2Book('BTC');
    expect(b.bids[0]?.sz).toBe('1.5');
    expect(b.bids[0]?.n_orders).toBe(2);
    expect(b.asks[0]?.px).toBe('25001');
  });

  it('userFills decodes the committed fill-ring record shape (coin SYMBOL)', async () => {
    const api = new InfoApi(BASE);
    // Canonical node fill shape: coin SYMBOL, 8-dp tape px, human-plane sz,
    // `time`, `block`.
    nextData = {
      address: ADDR,
      fills: [
        {
          coin: 'MTF',
          side: 'B',
          px: '0.12126000',
          sz: '112.22',
          time: 1_784_820_001_998,
          oid: 42,
          tid: 7,
          fee: '0.000952',
          closed_pnl: '0',
          dir: 'Open Long',
          start_position: '-357795.12',
          block: 8_416_000,
          hash: '',
        },
      ],
    };
    const res = await api.userFills(ADDR);
    const f = res.fills[0]!;
    // The node fill serializer renders the coin SYMBOL (a string), matching the
    // trade tape — NOT the numeric asset id.
    expect(f.coin).toBe('MTF');
    expect(typeof f.coin).toBe('string');
    expect(f.side).toBe('B');
    expect(f.dir).toBe('Open Long');
    expect(typeof f.fee).toBe('string');
    expect(typeof f.closed_pnl).toBe('string');
    expect(f.tid).toBe(7);
    // The trace-hash empty sentinel means "no on-chain tx".
    expect(f.hash).toBe('');
  });
});

// P2 wave-1 typed reads. Fixture VALUES mirror the node canonical wire shapes:
// the perp fill / order / funding / ledger-union records, the account-history
// empty-shape pins.
describe('InfoApi P2 wave-1 reads', () => {
  it('orderStatus sends exactly one of oid | cloid, and rejects neither/both', async () => {
    const api = new InfoApi(BASE);
    nextData = { status: 'unknown' };
    await api.orderStatus({ oid: 42 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'order_status',
      oid: 42,
    });
    const CLOID = '0x00000000000000000000000000000abc';
    await api.orderStatus({ cloid: CLOID });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'order_status',
      cloid: CLOID,
    });
    // Neither → throw; both → throw (the node requires exactly one).
    await expect(api.orderStatus({})).rejects.toThrow(/exactly one/);
    await expect(api.orderStatus({ oid: 1, cloid: CLOID })).rejects.toThrow(
      /exactly one/,
    );
  });

  it('orderStatus decodes the filled branch (canonical fill record)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      status: 'filled',
      fill: {
        coin: 'MTF',
        side: 'B',
        px: '0.12126000',
        sz: '112.22',
        time: 1_784_820_001_998,
        oid: 42,
        tid: 7,
        fee: '0.000952',
        closed_pnl: '0',
        dir: 'Open Long',
        start_position: '-357795.12',
        block: 8_416_000,
        hash: '',
      },
    };
    const res = await api.orderStatus({ oid: 42 });
    expect(res.status).toBe('filled');
    if (res.status === 'filled') {
      expect(res.fill.coin).toBe('MTF');
      expect(res.fill.px).toBe('0.12126000');
      expect(typeof res.fill.sz).toBe('string');
    }
  });

  it('orderStatus decodes the resting branch (side B/A, sz, inserted_at)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      status: 'resting',
      order: {
        oid: 42,
        coin: 'MTF',
        side: 'B',
        px: '0.12',
        sz: '112.22',
        inserted_at: 1_784_820_001_000,
        cloid: null,
      },
    };
    const res = await api.orderStatus({ oid: 42 });
    expect(res.status).toBe('resting');
    if (res.status === 'resting') {
      expect(res.order.side).toBe('B');
      expect(res.order.sz).toBe('112.22');
      expect(res.order.inserted_at).toBe(1_784_820_001_000);
      expect(res.order.cloid).toBeNull();
      expect(res.order.oid).toBe(42);
    }
  });

  it('orderStatus decodes the triggered branch (sz, registered_at)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      status: 'triggered',
      trigger: {
        oid: 43,
        coin: 'MTF',
        side: 'A',
        trigger_px: '0.20',
        trigger_above: true,
        sz: '10',
        registered_at: 1_784_820_002_000,
        fired: false,
        is_market: true,
        limit_px: null,
      },
    };
    const res = await api.orderStatus({ oid: 43 });
    expect(res.status).toBe('triggered');
    if (res.status === 'triggered') {
      expect(res.trigger.side).toBe('A');
      expect(res.trigger.sz).toBe('10');
      expect(res.trigger.registered_at).toBe(1_784_820_002_000);
      expect(res.trigger.limit_px).toBeNull();
    }
  });

  it('historicalOrders sends address + optional limit, decodes the canonical row', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, orders: [] };
    await api.historicalOrders(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'historical_orders',
      address: ADDR,
    });
    // order_canonical (gateway archive superset row).
    nextData = {
      address: ADDR,
      orders: [
        {
          oid: 9,
          coin: 'MTF',
          side: 'A',
          status: 'filled',
          time: 1_784_820_001_000,
          px: '194.78000000',
          filled_sz: '112.2',
          hash: '',
          limit_px: '194.78000000',
          avg_px: '194.78000000',
          sz: '112.2',
          orig_sz: '112.2',
          total_sz: '112.2',
          tif: 'Gtc',
          reduce_only: false,
        },
      ],
    };
    const res = await api.historicalOrders(ADDR, 50);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'historical_orders',
      address: ADDR,
      limit: 50,
    });
    const o = res.orders[0]!;
    expect(o.oid).toBe(9);
    expect(o.side).toBe('A');
    expect(o.status).toBe('filled');
    expect(o.px).toBe('194.78000000');
    expect(o.filled_sz).toBe('112.2');
    expect(o.tif).toBe('Gtc');
    expect(o.reduce_only).toBe(false);
  });

  it('userFunding echoes window bounds + keeps the 28-digit usdc verbatim', async () => {
    const api = new InfoApi(BASE);
    // Node empty-shape pin.
    nextData = { address: ADDR, start_time: null, end_time: null, fundings: [] };
    await api.userFunding(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_funding',
      address: ADDR,
    });
    // funding_canonical: usdc carries 28 significant digits — must survive as a
    // string (a fixed-precision re-parse would corrupt it).
    const USDC_28 = '0.0189543210987654321098765432';
    nextData = {
      address: ADDR,
      start_time: 1,
      end_time: 2,
      fundings: [
        {
          coin: 'MTF',
          time: 1_784_800_000_000,
          usdc: USDC_28,
          szi: '17415',
          funding_rate: '-0.0005',
        },
      ],
    };
    const res = await api.userFunding(ADDR, 1, 2);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_funding',
      address: ADDR,
      start_time: 1,
      end_time: 2,
    });
    expect(res.fundings[0]?.coin).toBe('MTF');
    expect(res.fundings[0]?.usdc).toBe(USDC_28);
    expect(res.fundings[0]?.funding_rate).toBe('-0.0005');
  });

  it('userLedgerUpdates types the envelope, leaves records raw', async () => {
    const api = new InfoApi(BASE);
    nextData = { address: ADDR, start_time: null, end_time: null, updates: [] };
    await api.userLedgerUpdates(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_ledger_updates',
      address: ADDR,
    });
    const res = await api.userLedgerUpdates(ADDR);
    expect(res.updates).toEqual([]);
  });

  it('userNonFundingLedgerUpdates decodes the camelCase ledgerUpdates union', async () => {
    const api = new InfoApi(BASE);
    // ledger_canonical 3-row union (money-movement / spot-token / trade).
    nextData = {
      ledgerUpdates: [
        { coin: 'USDC', time: 1_784_800_000_001, kind: 'deposit', delta: '100', counterparty: '0xabc' },
        { coin: 'PURR', time: 1_784_800_000_002, kind: 'spot_transfer', delta: '5' },
        { coin: 'MTF', time: 1_784_800_000_003, kind: 'trade', tid: 77, realized_pnl: '1.5', fee: '0.02', fee_token: 'USDC' },
      ],
    };
    const res = await api.userNonFundingLedgerUpdates(ADDR, 1, 2);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'user_non_funding_ledger_updates',
      address: ADDR,
      start_time: 1,
      end_time: 2,
    });
    expect(res.ledgerUpdates).toHaveLength(3);
    expect(res.ledgerUpdates[0]?.coin).toBe('USDC');
    expect(res.ledgerUpdates[1]?.kind).toBe('spot_transfer');
    expect(res.ledgerUpdates[2]?.tid).toBe(77);
    expect(res.ledgerUpdates[2]?.fee_token).toBe('USDC');
  });

  it('spotMarginState is keyed by `user` (NOT address)', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      user: ADDR,
      accounts: [
        {
          pair: 'BTC/USDC',
          collateral: '1000',
          borrowed: '500',
          borrow_index_snapshot: '1',
          base_held: '2.5',
          current_debt: '500',
          params: { init_bps: '2000', maint_bps: '1250' },
        },
      ],
    };
    const res = await api.spotMarginState(ADDR);
    // The request key is `user`, NOT `address` — the spot-margin surface quirk.
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'spot_margin_state',
      user: ADDR,
    });
    expect(res.user).toBe(ADDR);
    const a = res.accounts[0]!;
    // The pair is symbolized — a raw numeric pair id is no longer emitted.
    expect(a.pair).toBe('BTC/USDC');
    expect(a.current_debt).toBe('500');
    // Both bps params stay JSON STRINGS of integers.
    expect(a.params?.init_bps).toBe('2000');
    expect(a.params?.maint_bps).toBe('1250');
  });

  it('earnState sends `user` only when provided; user_* fields ride with it', async () => {
    const api = new InfoApi(BASE);
    nextData = { pools: [] };
    await api.earnState();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'earn_state' });
    nextData = {
      pools: [
        {
          name: 'USDC',
          signing_id: 0,
          total_supplied: '10000',
          total_borrowed: '4000',
          idle: '6000',
          shares_total: '10000',
          share_value: '1',
          borrow_index: '1',
          reserve_factor_bps: '1000',
          borrow_rate_bps_annual: '500',
          reserve_accrued: '3',
          user_shares: '250',
          user_value: '250',
        },
      ],
    };
    const res = await api.earnState(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'earn_state',
      user: ADDR,
    });
    const p = res.pools[0]!;
    // A pool row is keyed by `name`; `signing_id` is only for the write path.
    expect(p.name).toBe('USDC');
    expect(p.signing_id).toBe(0);
    expect(p.idle).toBe('6000');
    expect(p.user_shares).toBe('250');
    expect(p.user_value).toBe('250');
  });

  it('bridgeWithdrawalHistory carries the folded deployment rows', async () => {
    const api = new InfoApi(BASE);
    // A depositor with no in-flight withdrawal still gets the rows, so the
    // retired `bridge_chain_configs` ask costs one round trip here too.
    nextData = {
      entries: [],
      truncated: false,
      withdrawals_halted: true,
      configs: [
        {
          chain: 1,
          contract_address: `0x${'0'.repeat(61)}abc`,
          validator_quorum_threshold_bps: '6700',
          replay_nonce: 42,
          paused: false,
          evm_chain_id: 8453,
          evm_contract_address: `0x${'0'.repeat(37)}abc`,
          validator_set_epoch: 7,
          release_retention_ms: 0,
          effective_release_retention_ms: 86_400_000,
          scan_policy: {
            confirmations_only: false,
            confirmations: 0,
            effective_confirmations: 5,
            confirmations_only_depth: 0,
            usdc_token: `0x${'0'.repeat(37)}def`,
            raw_transfer_credit: true,
          },
        },
      ],
    };
    const res = await api.bridgeWithdrawalHistory(ADDR);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'bridge_withdrawal_history',
      address: ADDR,
    });
    expect(res.entries).toEqual([]);
    expect(res.withdrawals_halted).toBe(true);
    expect(res.configs[0]?.evm_chain_id).toBe(8453);
    expect(res.configs[0]?.validator_set_epoch).toBe(7);
    // Read the effective window, never the 0-as-unset raw one.
    expect(res.configs[0]?.effective_release_retention_ms).toBe(86_400_000);
    expect(res.configs[0]?.scan_policy.effective_confirmations).toBe(5);
  });

});

describe('InfoApi envelope validation', () => {
  it('throws when the response is not a {data} envelope', async () => {
    const api = new InfoApi(BASE);
    // Override the mock to return a bare (un-enveloped) body.
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ chain_id: 31337 }),
      }) as Response) as typeof fetch;
    await expect(api.feeSchedule()).rejects.toThrow(/envelope/);
  });

  it('throws when the echoed type does not match the request', async () => {
    const api = new InfoApi(BASE);
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ data: { type: 'something_else' } }),
      }) as Response) as typeof fetch;
    await expect(api.feeSchedule()).rejects.toThrow(/type mismatch/);
  });

  it('raises the error envelope with its code and details', async () => {
    const api = new InfoApi(BASE);
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              code: 'ORDER_INVALID_PRICE',
              message: 'price off grid: 12345 is not a multiple of tick_size 100',
              details: { field: 'px', limit: '100', actual: '12345' },
            },
          }),
      }) as Response) as typeof fetch;

    const caught = await api.feeSchedule().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(MetaFluxApiError);
    if (!(caught instanceof MetaFluxApiError)) throw new Error('no throw');
    expect(caught.status).toBe(400);
    expect(caught.code).toBe('ORDER_INVALID_PRICE');
    expect(caught.details).toEqual({
      field: 'px',
      limit: '100',
      actual: '12345',
    });
  });

  it('leaves details undefined when the rejection names no bound', async () => {
    const api = new InfoApi(BASE);
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: { code: 'UNKNOWN_TYPE', message: 'unknown info type: nope' },
          }),
      }) as Response) as typeof fetch;

    const caught = await api.feeSchedule().catch((e: unknown) => e);
    if (!(caught instanceof MetaFluxApiError)) throw new Error('no throw');
    expect(caught.code).toBe('UNKNOWN_TYPE');
    expect(caught.details).toBeUndefined();
  });

  it('raises an error body that arrives with a 200', async () => {
    // A COMMIT-time rejection is well-formed and was admitted, so it keeps its
    // 200. A status-only test would read it as a success.
    const api = new InfoApi(BASE);
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            error: { code: 'MARGIN_INSUFFICIENT', message: 'no margin' },
          }),
      }) as Response) as typeof fetch;

    const caught = await api.feeSchedule().catch((e: unknown) => e);
    if (!(caught instanceof MetaFluxApiError)) throw new Error('no throw');
    expect(caught.status).toBe(200);
    expect(caught.code).toBe('MARGIN_INSUFFICIENT');
  });

  it('accepts a code this release does not know', async () => {
    const api = new InfoApi(BASE);
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: { code: 'ORDER_FROM_A_NEWER_NODE', message: 'nope' },
          }),
      }) as Response) as typeof fetch;

    const caught = await api.feeSchedule().catch((e: unknown) => e);
    if (!(caught instanceof MetaFluxApiError)) throw new Error('no throw');
    expect(caught.code).toBe('ORDER_FROM_A_NEWER_NODE');
  });
});

// The node renamed the client-facing read surface. These specs pin the NEW
// keys, so a regression to the old ones fails here rather than at runtime.
describe('InfoApi realigned read shapes', () => {
  it('accountState groups positions by dex and returns balances as an array', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      account_value: '1000',
      withdrawable: '400',
      total_raw_usd: '987.5',
      total_margin_used: '600',
      total_ntl_pos: '12500',
      health: '850',
      tier: 'Safe',
      abstraction: 'unified',
      clearinghouse_state: {
        '': {
          positions: [
            {
              coin: 'BTC',
              size: '-0.5',
              entry: '25000',
              upnl: '12.5',
              isolated: false,
              lev: 10,
              liq: '30000',
              roe: '0.05',
              funding: '-1.25',
              margin: '1250',
              maint_margin: '150',
              notional: '12500',
            },
          ],
        },
        '0x00000000000000000000000000000000000000cc': { positions: [] },
      },
      balances: [
        { name: 'USDC', signing_id: 100, total: '1000', hold: '25' },
        { name: 'BTC', signing_id: 101, total: '0.5', hold: '0' },
      ],
      pm_maint_margin: '0',
      pm_net_value: '0',
      pm_concentration_penalty: '0',
      position_mode: 'one_way',
      height: 8_416_000,
      time: 1_784_820_001_000,
    };
    const res = await api.accountState(ADDR);
    // The core dex key is the empty string and is always present at full depth.
    const core = res.clearinghouse_state!['']!;
    const pos = core.positions[0]!;
    // A POSITION size key is `size` and is SIGNED. Order / book / trade rows
    // use `sz` instead — the two are deliberately different.
    expect(pos.size).toBe('-0.5');
    // The POSITION row keeps its own `maint_margin`. The rename is account-level.
    expect(pos.maint_margin).toBe('150');
    // A one-way account omits the hedge leg label.
    expect(pos.side).toBeUndefined();
    // A MIP-3 deployer dex keys by the deployer address.
    expect(
      res.clearinghouse_state!['0x00000000000000000000000000000000000000cc'],
    ).toBeDefined();
    // Balances are the WHOLE token ledger, an ARRAY of rows, USDC first.
    expect(res.balances![0]?.name).toBe('USDC');
    expect(res.balances![1]?.signing_id).toBe(101);
    // The folded PM figures are whole-USDC and always present.
    expect(res.pm_maint_margin).toBe('0');
    expect(res.pm_net_value).toBe('0');
    expect(res.pm_concentration_penalty).toBe('0');
    expect(res.position_mode).toBe('one_way');
    // REST bodies carry a flat height/time stamp.
    expect(res.height).toBe(8_416_000);
    expect(res.time).toBe(1_784_820_001_000);
    // Account-level scalars: the NEW names, and the old ones are gone.
    expect(res.total_margin_used).toBe('600');
    expect(res.total_raw_usd).toBe('987.5');
    expect(res.total_ntl_pos).toBe('12500');
    const raw = res as unknown as Record<string, unknown>;
    expect(raw.init_margin).toBeUndefined();
    expect(raw.maint_margin).toBeUndefined();
    expect(res.cross_maintenance_margin_used).toBeUndefined();
  });

  it('accountState surfaces health_deferred, and omits it when priceable', async () => {
    const api = new InfoApi(BASE);
    const base = {
      address: ADDR,
      account_value: '1000',
      withdrawable: '1000',
      total_raw_usd: '1000',
      total_margin_used: '0',
      total_ntl_pos: '0',
      health: '1000',
      tier: 'Safe',
      abstraction: 'unified',
      clearinghouse_state: { '': { positions: [] } },
      balances: [],
      pm_maint_margin: '0',
      pm_net_value: '0',
      pm_concentration_penalty: '0',
      position_mode: 'one_way',
      height: 8_416_000,
      time: 1_784_820_001_000,
    };
    // The node emits the key ONLY when the risk engine defers on the account.
    nextData = { ...base, health_deferred: true };
    const deferred = await api.accountState(ADDR);
    // Deferred: maint is 0 for want of a price, so `tier` / `health` are not
    // solvency statements.
    expect(deferred.health_deferred).toBe(true);
    expect(deferred.tier).toBe('Safe');

    nextData = base;
    const priceable = await api.accountState(ADDR);
    expect(priceable.health_deferred).toBeUndefined();
  });

  it('accountState keeps the hedge leg label distinct from the side token', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      clearinghouse_state: {
        '': {
          positions: [
            {
              coin: 'BTC',
              size: '0.5',
              entry: '25000',
              upnl: '0',
              isolated: false,
              lev: 5,
              liq: '0',
              roe: '0',
              funding: '0',
              margin: '0',
              maint_margin: '0',
              notional: '12500',
              side: 'long',
            },
          ],
        },
      },
      balances: [],
    };
    const res = await api.accountState(ADDR);
    // A hedge leg label is "long" / "short" — NOT the "B" / "A" side token.
    expect(res.clearinghouse_state?.['']?.positions[0]?.side).toBe('long');
    // `adl_lamps` rides `detail: "adl"` only, so the default depth omits it.
    expect(res.clearinghouse_state?.['']?.positions[0]?.adl_lamps).toBeUndefined();
  });

  it('accountState detail:adl posts the depth and reads adl_lamps, zero included', async () => {
    const api = new InfoApi(BASE);
    const pos = (coin: string, lamps: number) => ({
      coin,
      size: '0.5',
      entry: '25000',
      upnl: '10',
      isolated: false,
      lev: 5,
      liq: null,
      roe: '0',
      funding: '0',
      margin: '0',
      maint_margin: '0',
      notional: '12500',
      adl_lamps: lamps,
    });
    nextData = {
      address: ADDR,
      clearinghouse_state: { '': { positions: [pos('BTC', 4), pos('ETH', 0)] } },
      balances: [],
    };
    const res = await api.accountState(ADDR, 'adl');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'account_state',
      address: ADDR,
      detail: 'adl',
    });
    const rows = res.clearinghouse_state?.['']?.positions ?? [];
    expect(rows[0]?.adl_lamps).toBe(4);
    // Zero is a real answer — not in the queue — never "unknown".
    expect(rows[1]?.adl_lamps).toBe(0);
  });

  it('vaultState renders share_price on the human plane and keeps lock_period_ms', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      vault: VAULT,
      name: 'alpha',
      tvl: '100000',
      share_price: '1.045',
      depositor_count: 12,
      high_water_mark: '100000',
      performance_fee_bps: 1000,
      lock_period_ms: 86_400_000,
      strategy: 'User',
    };
    const res = await api.vaultState(VAULT);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'vault_state',
      vault: VAULT,
    });
    // `share_price` is whole USDC per WHOLE share. The node already applied
    // the share scale, so a client must NOT multiply by 1e18 again.
    expect(res.share_price).toBe('1.045');
    // `tvl` / `high_water_mark` are whole USDC, not cents.
    expect(res.tvl).toBe('100000');
    // `lock_period_ms` is a DURATION and KEEPS its `_ms` suffix.
    expect(res.lock_period_ms).toBe(86_400_000);
  });

  it('markets keeps the funding interval_ms duration and the _ts boundary', async () => {
    const api = new InfoApi(BASE);
    nextType = 'markets';
    nextData = {
      perp: [{
        coin: 'BTC',
        funding: {
          rate_per_hr: '1',
          cap_per_hr: '4',
          interval_ms: 3_600_000,
          next_payment_ts: 1_783_011_600_000,
        },
      }],
      spot: { pairs: [], tokens: [] },
    };
    const res = (await api.markets('BTC')).perp[0]!;
    // A DURATION keeps `_ms`; only timestamps dropped the suffix.
    expect(res.funding.interval_ms).toBe(3_600_000);
    expect(res.funding.next_payment_ts).toBe(1_783_011_600_000);
  });

  it('timestamp fields dropped the _ms suffix across the read surface', async () => {
    const api = new InfoApi(BASE);

    nextData = {
      address: ADDR,
      vault: { equities: [], vaults: [] },
      staking: {
        state: { total_staked: '0', delegations: [], pending_unstakes: [] },
        summary: {
          total_delegated: '0',
          pending_withdrawal: '0',
          claimable_rewards: '0',
          n_delegations: 0,
        },
      },
      sub_accounts: [],
      multisig: { is_multi_sig: false, threshold: 0, signers: [] },
      agents: [{ agent: ADDR, name: 'bot', expires_at: null }],
      height: 8_416_000,
      time: 1_784_820_001_000,
    };
    expect((await api.accountOverview(ADDR)).agents[0]?.expires_at).toBeNull();

    nextData = {
      coin: 'BTC',
      last_trade: 1_784_820_001_000,
      start_time: null,
      end_time: null,
      trades: [],
    };
    expect((await api.trades('BTC')).last_trade).toBe(1_784_820_001_000);

    nextData = {
      auction_round: 3,
      current_bid: '500',
      current_winner: null,
      auction_end: 1_784_900_000_000,
      started_at: 1_784_800_000_000,
      bids: [{ bidder: ADDR, amount: '500', submitted_at: 1_784_810_000_000, tag: 'X' }],
    };
    const mip3 = await api.mip3ActiveBids();
    expect(mip3.auction_end).toBe(1_784_900_000_000);
    expect(mip3.started_at).toBe(1_784_800_000_000);
    expect(mip3.bids[0]?.submitted_at).toBe(1_784_810_000_000);

    nextData = {
      spot_disabled: false,
      post_only_until_time: 1_784_900_000_000,
      post_only_until_height: 0,
      scheduled_freeze_height: null,
      mip3_enabled: true,
      frozen: false,
      replay_complete: true,
    };
    // `post_only_until_time` keeps `_time` and drops only `_ms`.
    expect((await api.exchangeStatus()).post_only_until_time).toBe(
      1_784_900_000_000,
    );

    nextData = {
      auction_round: 1,
      current_bid: '0',
      current_winner: null,
      auction_end: 1_784_900_000_000,
      started_at: 1_784_800_000_000,
      total_burned: '0',
      deposit: '0',
    };
    const deploy = await api.spotDeployAuction();
    expect(deploy.auction_end).toBe(1_784_900_000_000);
    expect(deploy.started_at).toBe(1_784_800_000_000);

    nextData = { latest_round: 9, votes: [{ round: 9, validator: ADDR, submitted_at: 5 }] };
    expect((await api.validatorL1Votes()).votes[0]?.submitted_at).toBe(5);

    nextData = {
      epoch: 12,
      total_stake: '1',
      n_active: 1,
      validators: [
        {
          validator: ADDR,
          signer: ADDR,
          validator_index: 0,
          stake: '1',
          self_stake: '1',
          commission_bps: '500',
          is_active: true,
          is_jailed: false,
          jailed_at: null,
          unjail_at: null,
          first_active_epoch: 1,
        },
      ],
    };
    const vs = await api.validatorSummaries();
    expect(vs.validators[0]?.jailed_at).toBeNull();
    expect(vs.validators[0]?.unjail_at).toBeNull();
  });

  it('accountState.balances carries the optional avg_entry_px cost basis', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      account_value: '0',
      withdrawable: '0',
      total_raw_usd: '0',
      total_margin_used: '0',
      total_ntl_pos: '0',
      health: '0',
      tier: 'Safe',
      abstraction: 'unified',
      position_mode: 'one_way',
      clearinghouse_state: { '': { positions: [] } },
      balances: [
        // Deposited / pre-basis holding: no entry recorded, so no key.
        { name: 'USDC', signing_id: 100, total: '390548', hold: '390548' },
        { name: 'MTF', signing_id: 104, total: '10000039.5196599', hold: '3000000', avg_entry_px: '412.5' },
      ],
      pm_maint_margin: '0',
      pm_net_value: '0',
      pm_concentration_penalty: '0',
      height: 6_845_318,
      time: 1_786_164_224_330,
    };
    const res = await api.accountState(ADDR);
    // Absent means UNKNOWN, never zero -- a deposit writes no basis at all.
    expect(res.balances![0]?.avg_entry_px).toBeUndefined();
    expect(res.balances![1]?.avg_entry_px).toBe('412.5');
  });

  it('accountState margin depth adds the cross maint scalar and drops the walks', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      address: ADDR,
      account_value: '100',
      withdrawable: '10',
      total_raw_usd: '100',
      total_margin_used: '20',
      cross_maintenance_margin_used: '15',
      health: '85',
      tier: 'Safe',
      abstraction: 'unified',
      position_mode: 'one_way',
      pm_maint_margin: '0',
      pm_net_value: '0',
      pm_concentration_penalty: '0',
      height: 8_416_000,
      time: 1_784_820_001_000,
    };
    const res = await api.accountState(ADDR, 'margin');
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'account_state',
      address: ADDR,
      detail: 'margin',
    });
    // `cross_maintenance_margin_used` is served at THIS depth only.
    expect(res.cross_maintenance_margin_used).toBe('15');
    expect(res.total_margin_used).toBe('20');
    expect(res.total_raw_usd).toBe('100');
    // The walks are skipped, so both collections and `total_ntl_pos` are
    // absent, not empty-wrong.
    expect(res.clearinghouse_state).toBeUndefined();
    expect(res.balances).toBeUndefined();
    expect(res.total_ntl_pos).toBeUndefined();
  });

  it('optionSeries POSTs the bare type and keeps both kinds apart', async () => {
    const api = new InfoApi(BASE);
    nextData = {
      series: [
        {
          signing_id: 2_147_483_649,
          underlying: 'BTC',
          kind: 'put',
          strike: '100000',
          expiry: 1_735_689_600_000,
          sz_decimals: 5,
          escrow_per_unit: '100000',
        },
        {
          signing_id: 2_147_483_650,
          underlying: 'BTC',
          kind: 'capped_call',
          strike: '100000',
          cap: '130000',
          expiry: 1_735_689_600_000,
          sz_decimals: 5,
          escrow_per_unit: '30000',
        },
      ],
    };
    const res = await api.optionSeries();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'option_series' });
    expect(res.series).toHaveLength(2);
    // The signing id is served whole — it is the number an RFQ action carries.
    expect(res.series[0]!.signing_id).toBe(2_147_483_649);
    // A put carries no cap, and locks the strike.
    expect(res.series[0]!.cap).toBeUndefined();
    expect(res.series[0]!.escrow_per_unit).toBe('100000');
    // A capped call locks the WIDTH, not the strike.
    expect(res.series[1]!.kind).toBe('capped_call');
    expect(res.series[1]!.cap).toBe('130000');
    expect(res.series[1]!.escrow_per_unit).toBe('30000');
  });

  it('optionPositions sends the address and keeps the two planes apart', async () => {
    const api = new InfoApi(BASE);
    const who = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    nextData = {
      address: who,
      positions: [
        {
          signing_id: 2_147_483_650,
          underlying: 'BTC',
          kind: 'capped_call',
          strike: '100000',
          expiry: 1_735_689_600_000,
          long: '0',
          short: '1.5',
          escrow: '45000',
        },
      ],
    };
    const res = await api.optionPositions(who);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'option_positions',
      address: who,
    });
    expect(res.positions).toHaveLength(1);
    expect(res.positions[0]!.signing_id).toBe(2_147_483_650);
    // `short` is a UNIT count on the series size scale ...
    expect(res.positions[0]!.short).toBe('1.5');
    expect(res.positions[0]!.long).toBe('0');
    // ... and `escrow` is USDC. Reading one as the other is the failure this
    // read warns about; both are strings, so only the name separates them.
    expect(res.positions[0]!.escrow).toBe('45000');
  });

  it('optionPositions returns an empty list for an account party to nothing', async () => {
    const api = new InfoApi(BASE);
    const who = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    nextData = { address: who, positions: [] };
    const res = await api.optionPositions(who);
    expect(res.positions).toEqual([]);
  });

  it('drops the frontend_open_orders method', () => {
    const api = new InfoApi(BASE) as unknown as Record<string, unknown>;
    // The kind has no dispatch arm on the node; a request 400s.
    expect(api.frontendOpenOrders).toBeUndefined();
  });
});
