// WS client wire-protocol tests — pure TS, no WASM. Drives the WsClient against
// a minimal in-process WebSocket mock and asserts the EXACT frames the server's
// `/ws` endpoint parses (snake_case native, per the KB spec
// metaflux-knowledges/api/ws/subscriptions.md):
//   {"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC"}}
//   {"method":"unsubscribe","subscription":{"type":"trades"}}
//   {"method":"ping"}
// and that inbound {"channel","data"} frames fan out to handlers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WsClient,
  WS_CHANNELS,
  isChannelFrame,
  type WsFrame,
} from '../src/ws/ws.js';

// Minimal WebSocket stand-in. Records every sent frame; lets the test inject
// inbound messages and lifecycle events.
class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((ev: { data: string }) => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: (() => void) | undefined;

  constructor(public readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  // Test helpers.
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  inbound(raw: string): void {
    this.onmessage?.({ data: raw });
  }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket =
    MockSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = RealWebSocket;
});

describe('WsClient wire protocol', () => {
  it('connect resolves once the socket opens', async () => {
    const ws = new WsClient('wss://api.mtf.exchange/ws', {
      autoReconnect: false,
    });
    const p = ws.connect();
    MockSocket.instances[0]!.open();
    await p;
    expect(ws.isOpen).toBe(true);
    expect(MockSocket.instances[0]!.url).toBe('wss://api.mtf.exchange/ws');
    ws.close();
  });

  it('subscribe emits the exact server-parsed frame', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    await ws.subscribe({ type: 'l2_book', coin: 'BTC' });
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC"}}',
    );
    ws.close();
  });

  it('unsubscribe emits a coin-less frame when no coin given', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    await ws.unsubscribe({ type: 'trades' });
    expect(sock.sent).toContain(
      '{"method":"unsubscribe","subscription":{"type":"trades"}}',
    );
    ws.close();
  });

  it('replays active subscriptions after reconnect', async () => {
    const ws = new WsClient('wss://x/ws', {
      autoReconnect: true,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const p = ws.connect();
    const first = MockSocket.instances[0]!;
    first.open();
    await p;
    await ws.subscribe({ type: 'bbo', coin: 'ETH' });

    // Simulate an unexpected drop → background reconnect creates a new socket.
    first.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(MockSocket.instances.length).toBeGreaterThanOrEqual(2);
    const second = MockSocket.instances[MockSocket.instances.length - 1]!;
    second.open();
    // The bbo subscription is re-issued on the fresh socket without the caller
    // doing anything.
    expect(second.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"bbo","coin":"ETH"}}',
    );
    ws.close();
  });

  it('dispatches inbound channel frames to handlers', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const got: { channel: string; data: unknown }[] = [];
    ws.onMessage((f) => got.push(f));
    sock.inbound('{"channel":"l2_book","data":{"coin":"BTC","levels":[[],[]]}}');
    sock.inbound('{"channel":"error","data":{"error":"bad channel"}}');

    expect(got).toHaveLength(2);
    expect(got[0]!.channel).toBe('l2_book');
    expect(got[1]!.channel).toBe('error');
    expect((got[1]!.data as { error: string }).error).toBe('bad channel');
    ws.close();
  });

  it('ignores malformed inbound frames', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const got: unknown[] = [];
    ws.onMessage((f) => got.push(f));
    sock.inbound('not json');
    sock.inbound('{"no_channel":1}');
    expect(got).toHaveLength(0);
    ws.close();
  });

  it('exposes the exact 22 native gateway channel names (spot_state GONE)', () => {
    expect([...WS_CHANNELS]).toEqual([
      'l2_book',
      'bbo',
      'trades',
      'active_asset_ctx',
      'all_mids',
      'markets',
      'explorer_block',
      'explorer_txs',
      'candles',
      'fills',
      'user_events',
      'order_updates',
      'open_orders',
      'notifications',
      'ledger_updates',
      'user_fundings',
      'user_twap_slice_fills',
      'user_twap_history',
      'account_state',
      'web_data',
      'spot_margin_state',
      'active_asset_data',
    ]);
    expect(WS_CHANNELS).toHaveLength(22);
    expect(WS_CHANNELS).toContain('web_data');
    expect(WS_CHANNELS).toContain('spot_margin_state');
    // Both removed server-side: a subscribe answers with the error envelope.
    expect(WS_CHANNELS).not.toContain('web_data2');
    expect(WS_CHANNELS).not.toContain('spot_state');
  });

  it('subscribes to the two new per-account channels by `user`', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const USER = '0x00000000000000000000000000000000000000aa';
    await ws.subscribeWebData(USER);
    expect(sock.sent).toContain(
      `{"method":"subscribe","subscription":{"type":"web_data","user":"${USER}"}}`,
    );
    await ws.subscribeSpotMarginState(USER);
    expect(sock.sent).toContain(
      `{"method":"subscribe","subscription":{"type":"spot_margin_state","user":"${USER}"}}`,
    );
    ws.close();
  });

  it('surfaces the is_snapshot envelope flag; absent reads as a delta', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const got: WsFrame[] = [];
    ws.onMessage((f) => got.push(f));
    sock.inbound('{"channel":"open_orders","data":[],"is_snapshot":true}');
    sock.inbound('{"channel":"open_orders","data":[],"is_snapshot":false}');
    sock.inbound('{"channel":"open_orders","data":[]}');
    expect(got[0]?.is_snapshot).toBe(true);
    expect(got[1]?.is_snapshot).toBe(false);
    // An absent flag stays absent, so a delta is never read as a snapshot.
    expect(got[2]?.is_snapshot).toBeUndefined();
    ws.close();
  });

  it('subscribe helpers send the coin market SYMBOL', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    await ws.subscribeL2Book('BTC');
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC"}}',
    );
    await ws.subscribeCandles('ETH', '5m');
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"candles","coin":"ETH","interval":"5m"}}',
    );
    await ws.subscribeAllMids();
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"all_mids"}}',
    );
    await ws.subscribeExplorerBlock();
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"explorer_block"}}',
    );
    await ws.subscribeExplorerTxs();
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"explorer_txs"}}',
    );
    await ws.subscribeUserFundings('0x00000000000000000000000000000000000000aa');
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"user_fundings","user":"0x00000000000000000000000000000000000000aa"}}',
    );
    await ws.subscribeActiveAssetData(
      '0x00000000000000000000000000000000000000aa',
      'BTC',
    );
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"active_asset_data","coin":"BTC","user":"0x00000000000000000000000000000000000000aa"}}',
    );
    ws.close();
  });

  it('subscribeL2Book serializes aggregation params as snake_case', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    await ws.subscribeL2Book('BTC', { nSigFigs: 5, mantissa: 2, nLevels: 20 });
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC","n_sig_figs":5,"mantissa":2,"n_levels":20}}',
    );
    // A spot pair name subscribes for spot depth; partial params send only the
    // defined field.
    await ws.subscribeL2Book('BTC/USDC', { nSigFigs: 3 });
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC/USDC","n_sig_figs":3}}',
    );
    ws.close();
  });

  it('re-subscribing l2_book for a coin REPLACES the prior view in the replay set', async () => {
    const ws = new WsClient('wss://x/ws', {
      autoReconnect: true,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const p = ws.connect();
    const first = MockSocket.instances[0]!;
    first.open();
    await p;

    // Two l2_book subs for the SAME coin with different params: the server
    // holds one view per coin and replaces it, so only the latest may survive
    // in the reconnect-replay set (a stale entry would clobber the new params).
    await ws.subscribeL2Book('BTC', { nSigFigs: 2 });
    await ws.subscribeL2Book('BTC', { nSigFigs: 5, nLevels: 20 });

    // Drop → reconnect → the fresh socket replays active subs.
    first.close();
    await new Promise((r) => setTimeout(r, 10));
    const second = MockSocket.instances[MockSocket.instances.length - 1]!;
    second.open();

    const l2Replays = second.sent.filter((s) => s.includes('"l2_book"'));
    expect(l2Replays).toHaveLength(1);
    expect(l2Replays[0]).toBe(
      '{"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC","n_sig_figs":5,"n_levels":20}}',
    );
    ws.close();
  });

  it('unsubscribe drops the l2_book view for a coin regardless of params', async () => {
    const ws = new WsClient('wss://x/ws', {
      autoReconnect: true,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const p = ws.connect();
    const first = MockSocket.instances[0]!;
    first.open();
    await p;

    await ws.subscribeL2Book('BTC', { nSigFigs: 5, nLevels: 20 });
    // Params-blind unsubscribe (server keys unsubscribe by coin alone).
    await ws.unsubscribe({ type: 'l2_book', coin: 'BTC' });

    first.close();
    await new Promise((r) => setTimeout(r, 10));
    const second = MockSocket.instances[MockSocket.instances.length - 1]!;
    second.open();
    // Nothing to replay — the view was removed.
    expect(second.sent.filter((s) => s.includes('"l2_book"'))).toHaveLength(0);
    ws.close();
  });

  it('postInfo correlates the response by id and unwraps payload', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const reply = ws.postInfo({ type: 'node_info' });
    // The frame went out as a `post` with id 1 and the info request payload.
    const frame = JSON.parse(sock.sent[sock.sent.length - 1]!) as {
      method: string;
      id: number;
      request: { type: string; payload: unknown };
    };
    expect(frame.method).toBe('post');
    expect(frame.id).toBe(1);
    expect(frame.request.type).toBe('info');
    expect(frame.request.payload).toEqual({ type: 'node_info' });

    // The node echoes the id and wraps `{type, payload}`; post() returns payload.
    sock.inbound(
      `{"channel":"post","data":{"id":1,"response":{"type":"info","payload":{"network":"devnet"}}}}`,
    );
    expect(await reply).toEqual({ network: 'devnet' });
    // A `post` frame is consumed by the correlator, not fanned out to handlers.
    ws.close();
  });

  it('postInfo surfaces a {type:"error"} response as a rejection', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const reply = ws.postInfo({ type: 'bogus' });
    const id = (
      JSON.parse(sock.sent[sock.sent.length - 1]!) as { id: number }
    ).id;
    sock.inbound(
      `{"channel":"post","data":{"id":${id},"response":{"type":"error","payload":"no such query"}}}`,
    );
    await expect(reply).rejects.toThrow(/no such query/);
    ws.close();
  });

  it('post frames are not fanned out to subscription handlers', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const got: WsFrame[] = [];
    ws.onMessage((f) => got.push(f));
    // No pending post with this id — the correlator drops it; handlers never see it.
    sock.inbound(
      '{"channel":"post","data":{"id":999,"response":{"type":"info","payload":{}}}}',
    );
    expect(got).toHaveLength(0);
    ws.close();
  });

  it('postAction / submitOrder throw without a signer', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    MockSocket.instances[0]!.open();
    await p;
    // postAction now takes (actionType, payload) and signs the typed digest.
    await expect(
      ws.postAction('set_position_mode', { hedge: true }),
    ).rejects.toThrow(/WsSigner/);
    ws.close();
  });

  it('subscriptionResponse / error / bare-pong inbound frames all decode', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    const got: WsFrame[] = [];
    ws.onMessage((f) => got.push(f));
    // camelCase ack channel; error carries data.error; pong is a bare frame.
    sock.inbound(
      '{"channel":"subscriptionResponse","data":{"method":"subscribe","subscription":{"type":"l2_book","coin":"1"}}}',
    );
    sock.inbound('{"channel":"error","data":{"error":"bad channel"}}');
    sock.inbound('{"channel":"pong"}');

    expect(got.map((f) => f.channel)).toEqual([
      'subscriptionResponse',
      'error',
      'pong',
    ]);
    // The bare pong has no `data` — passthrough leaves it `undefined`, no crash.
    expect(got[2]!.data).toBeUndefined();
    ws.close();
  });
});

// Channel-body decode tests. Each body below is shaped like the LIVE server
// frame for that channel. `isChannelFrame` narrows `data` to the channel's DTO,
// so every property read here is TYPECHECKED — a DTO key that drifts from the
// server fails `pnpm run typecheck`, not just the runtime assertion.
describe('WS channel body decode', () => {
  // Open a client, push one raw frame, and hand back the frame it fanned out.
  async function inbound(raw: string): Promise<WsFrame> {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const p = ws.connect();
    const sock = MockSocket.instances[MockSocket.instances.length - 1]!;
    sock.open();
    await p;
    const got: WsFrame[] = [];
    ws.onMessage((f) => got.push(f));
    sock.inbound(raw);
    ws.close();
    return got[0]!;
  }

  it('user_fundings carries `usdc` + `funding_rate` and a coin SYMBOL', async () => {
    const f = await inbound(
      '{"channel":"user_fundings","data":[{"coin":"BTC","usdc":"-7.5",' +
        '"szi":"1.5","funding_rate":"0.00125","time":1784820001998}]}',
    );
    expect(isChannelFrame(f, 'user_fundings')).toBe(true);
    if (!isChannelFrame(f, 'user_fundings')) return;
    const r = f.data[0]!;
    // The settled-cash key is `usdc`, NOT `payment`; the rate key is
    // snake_case `funding_rate`, NOT `fundingRate`.
    expect(r.usdc).toBe('-7.5');
    expect(r.funding_rate).toBe('0.00125');
    expect(r.szi).toBe('1.5');
    // `coin` is the market SYMBOL string, never a numeric asset id.
    expect(r.coin).toBe('BTC');
    expect(r.time).toBe(1_784_820_001_998);
  });

  it('active_asset_ctx nests every metric under `ctx`', async () => {
    const f = await inbound(
      '{"channel":"active_asset_ctx","data":{"coin":"BTC","ctx":{' +
        '"mark_px":"25000.00","oracle_px":"24999.50","mid_px":"25000.25",' +
        '"premium":"0.00012500","day_ntl_vlm":"1250000.5",' +
        '"prev_day_px":"24000.00","change_24h":"0.0416",' +
        '"funding":{"rate_per_hr":"1.25","cap_per_hr":"400",' +
        '"interval_ms":3600000,"next_payment_ts":1784823600000},' +
        '"open_interest":"812.35"}}}',
    );
    if (!isChannelFrame(f, 'active_asset_ctx')) throw new Error('narrow failed');
    expect(f.data.coin).toBe('BTC');
    // Flat reads are gone — every metric hangs off `ctx`.
    expect(f.data.ctx.mark_px).toBe('25000.00');
    expect(f.data.ctx.oracle_px).toBe('24999.50');
    expect(f.data.ctx.mid_px).toBe('25000.25');
    expect(f.data.ctx.premium).toBe('0.00012500');
    expect(f.data.ctx.day_ntl_vlm).toBe('1250000.5');
    expect(f.data.ctx.prev_day_px).toBe('24000.00');
    expect(f.data.ctx.change_24h).toBe('0.0416');
    expect(f.data.ctx.open_interest).toBe('812.35');
    expect(f.data.ctx.funding?.interval_ms).toBe(3_600_000);
    // A healthy market omits the staleness marker.
    expect(f.data.ctx.px_stale).toBeUndefined();
  });

  it('active_asset_ctx keeps the nullable + conditional ctx members', async () => {
    // Unknown / one-sided market: null funding, null mid, null 24h reference,
    // and the stale marker present.
    const f = await inbound(
      '{"channel":"active_asset_ctx","data":{"coin":"NEW","ctx":{' +
        '"mark_px":"0","oracle_px":"0","px_stale":true,"mid_px":null,' +
        '"premium":null,"day_ntl_vlm":"0","prev_day_px":null,' +
        '"change_24h":null,"funding":null,"open_interest":"0"}}}',
    );
    if (!isChannelFrame(f, 'active_asset_ctx')) throw new Error('narrow failed');
    expect(f.data.ctx.px_stale).toBe(true);
    expect(f.data.ctx.mid_px).toBeNull();
    expect(f.data.ctx.premium).toBeNull();
    expect(f.data.ctx.prev_day_px).toBeNull();
    expect(f.data.ctx.change_24h).toBeNull();
    expect(f.data.ctx.funding).toBeNull();
  });

  it('candles decodes the gateway envelope and the node bar separately', async () => {
    const gw = await inbound(
      '{"channel":"candles","data":{"snapshot":true,"candles":[{' +
        '"t":1784820000000,"T":1784820059999,"s":"BTC","i":"1m",' +
        '"o":"25000","c":"25010","h":"25015","l":"24995",' +
        '"v":"3.5","n":12,"q":"87517.5"}]},"is_snapshot":false}',
    );
    if (!isChannelFrame(gw, 'candles')) throw new Error('narrow failed');
    if (Array.isArray(gw.data)) throw new Error('expected the gateway envelope');
    // The envelope carries its OWN snapshot flag; the frame flag stays false.
    expect(gw.data.snapshot).toBe(true);
    expect(gw.is_snapshot).toBe(false);
    const bar = gw.data.candles[0]!;
    expect(bar.s).toBe('BTC');
    expect(bar.i).toBe('1m');
    expect(bar.q).toBe('87517.5');

    // A node-direct mount sends a BARE ARRAY of bars labelled `coin` /
    // `interval`, with no quote volume.
    const node = await inbound(
      '{"channel":"candles","data":[{"coin":"BTC","interval":"1m",' +
        '"t":1784820000000,"T":1784820060000,"o":"25000","h":"25015",' +
        '"l":"24995","c":"25010","v":"3.5","n":12}]}',
    );
    if (!isChannelFrame(node, 'candles')) throw new Error('narrow failed');
    if (!Array.isArray(node.data)) throw new Error('expected the node array');
    const nb = node.data[0]!;
    expect(nb.coin).toBe('BTC');
    expect(nb.interval).toBe('1m');
    expect(nb.t).toBe(1_784_820_000_000);
    expect(nb.T).toBe(1_784_820_060_000);
    expect([nb.o, nb.h, nb.l, nb.c]).toEqual([
      '25000',
      '25015',
      '24995',
      '25010',
    ]);
    expect(nb.v).toBe('3.5');
    expect(nb.n).toBe(12);
  });

  it('account_state decodes the live dex-keyed body with health_deferred', async () => {
    const f = await inbound(
      '{"channel":"account_state","data":{' +
        '"address":"0x00000000000000000000000000000000000000aa",' +
        '"account_value":"1000","free_collateral":"400","init_margin":"600",' +
        '"health":"1000","tier":"Safe","health_deferred":true,' +
        '"abstraction":"unified",' +
        '"clearinghouse_state":{"":{"positions":[]}},' +
        '"balances":[{"asset":0,"name":"USDC","total":"1000","hold":"0"}],' +
        '"pm_maint_margin":"0","pm_net_value":"0",' +
        '"pm_concentration_penalty":"0","position_mode":"one_way",' +
        '"height":8416000,"time":1784820001000},"is_snapshot":true}',
    );
    if (!isChannelFrame(f, 'account_state')) throw new Error('narrow failed');
    // The core dex key is the EMPTY STRING; positions are grouped by dex.
    expect(f.data.clearinghouse_state['']?.positions).toEqual([]);
    // A deferred account reports maint 0 for want of a price — `tier` and
    // `health` are then not solvency statements.
    expect(f.data.health_deferred).toBe(true);
    expect(f.data.height).toBe(8_416_000);
    expect(f.is_snapshot).toBe(true);
  });

  it('l2_book carries [bids, asks] under `levels` with the `n` count key', async () => {
    const f = await inbound(
      '{"channel":"l2_book","data":{"coin":"BTC","levels":[' +
        '[{"px":"25000","sz":"1.5","n":2}],[{"px":"25001","sz":"0.75","n":1}]' +
        '],"time":1784820001000}}',
    );
    if (!isChannelFrame(f, 'l2_book')) throw new Error('narrow failed');
    expect(f.data.coin).toBe('BTC');
    const [bids, asks] = f.data.levels;
    // The WS count key is `n`; the REST l2_book read spells it `n_orders`.
    expect(bids[0]!.n).toBe(2);
    expect(bids[0]!.px).toBe('25000');
    expect(bids[0]!.sz).toBe('1.5');
    expect(asks[0]!.px).toBe('25001');
    expect(f.data.time).toBe(1_784_820_001_000);
  });

  it('bbo carries a [bid, ask] tuple that is null on an empty side', async () => {
    const f = await inbound(
      '{"channel":"bbo","data":{"coin":"BTC","time":1784820001000,' +
        '"bbo":[{"px":"25000","sz":"1.5","n":2},null]}}',
    );
    if (!isChannelFrame(f, 'bbo')) throw new Error('narrow failed');
    expect(f.data.coin).toBe('BTC');
    expect(f.data.time).toBe(1_784_820_001_000);
    const [bid, ask] = f.data.bbo;
    expect(bid?.px).toBe('25000');
    expect(ask).toBeNull();
  });

  it('markets pushes an array of dynamic rows, perp and spot', async () => {
    const f = await inbound(
      '{"channel":"markets","data":[' +
        '{"coin":"BTC","kind":"perp","mark_px":"25000","oracle_px":"24999",' +
        '"mid_px":"25000.5","impact_pxs":["24990","25010"],"premium":"0.0001",' +
        '"funding":{"rate_per_hr":"1.25","cap_per_hr":"400",' +
        '"interval_ms":3600000,"next_payment_ts":1784823600000},' +
        '"open_interest":"812.35","day_ntl_vlm":"1250000.5",' +
        '"prev_day_px":"24000","change_24h":"0.0416","halted":false},' +
        '{"coin":"MTF/USDC","kind":"spot","mark_px":"0.12126",' +
        '"day_ntl_vlm":"4210.5","prev_day_px":"0.11"}],"is_snapshot":true}',
    );
    if (!isChannelFrame(f, 'markets')) throw new Error('narrow failed');
    const [perp, spot] = f.data;
    expect(perp!.kind).toBe('perp');
    expect(perp!.coin).toBe('BTC');
    expect(perp!.mark_px).toBe('25000');
    expect(perp!.oracle_px).toBe('24999');
    expect(perp!.mid_px).toBe('25000.5');
    expect(perp!.impact_pxs?.[1]).toBe('25010');
    expect(perp!.premium).toBe('0.0001');
    expect(perp!.funding?.rate_per_hr).toBe('1.25');
    expect(perp!.open_interest).toBe('812.35');
    expect(perp!.day_ntl_vlm).toBe('1250000.5');
    expect(perp!.prev_day_px).toBe('24000');
    expect(perp!.change_24h).toBe('0.0416');
    expect(perp!.halted).toBe(false);
    // A healthy perp row omits the staleness marker.
    expect(perp!.px_stale).toBeUndefined();
    // A spot row carries only the fields spot has an analogue for.
    expect(spot!.kind).toBe('spot');
    expect(spot!.coin).toBe('MTF/USDC');
    expect(spot!.mark_px).toBe('0.12126');
    expect(spot!.day_ntl_vlm).toBe('4210.5');
    expect(spot!.prev_day_px).toBe('0.11');
    expect(spot!.oracle_px).toBeUndefined();
    expect(spot!.funding).toBeUndefined();
  });

  it('user_events wraps the fill legs under a tagged `fills` key', async () => {
    const f = await inbound(
      '{"channel":"user_events","data":{"fills":[{"coin":"BTC","side":"B",' +
        '"px":"25000","sz":"0.5","time":1784820001000,"oid":42,"cloid":null,' +
        '"tid":7,"crossed":true,"block":8416000,"hash":"0xabc"}]}}',
    );
    if (!isChannelFrame(f, 'user_events')) throw new Error('narrow failed');
    expect(f.data.fills[0]!.crossed).toBe(true);
    expect(f.data.fills[0]!.oid).toBe(42);
  });

  it('notifications tags each record by `kind`', async () => {
    const f = await inbound(
      '{"channel":"notifications","data":[' +
        '{"kind":"yellow_card","tier":"yellow_card","message":"warn",' +
        '"time":1784820001000},' +
        '{"kind":"forced_close","coin":"BTC","side":"long",' +
        '"closed_sz":"0.25","message":"closed","time":1784820001000},' +
        '{"kind":"backstop_residual","coin":"BTC","side":"short","lots":"40",' +
        '"message":"parked","time":1784820001000},' +
        '{"kind":"mlp_backstop_takeover","coin":"BTC","signed_sz":"-1.5",' +
        '"px":"25000","message":"takeover","time":1784820001000}]}',
    );
    if (!isChannelFrame(f, 'notifications')) throw new Error('narrow failed');
    const [warn, close, parked, takeover] = f.data;
    expect(warn!.kind).toBe('yellow_card');
    expect(warn!.tier).toBe('yellow_card');
    expect(warn!.message).toBe('warn');
    expect(warn!.time).toBe(1_784_820_001_000);
    expect(close!.kind).toBe('forced_close');
    expect(close!.coin).toBe('BTC');
    expect(close!.closed_sz).toBe('0.25');
    expect(close!.side).toBe('long');
    expect(parked!.lots).toBe('40');
    // The takeover record can never be confused with a fill.
    expect(takeover!.signed_sz).toBe('-1.5');
    expect(takeover!.px).toBe('25000');
  });

  it('ledger_updates carries an UNSIGNED `amount` tagged by `kind`', async () => {
    const f = await inbound(
      '{"channel":"ledger_updates","data":[' +
        '{"kind":"usd_send","destination":"0x00000000000000000000000000000000000000bb",' +
        '"amount":"25.5","time":1784820001000},' +
        '{"kind":"usd_receive","from":"0x00000000000000000000000000000000000000aa",' +
        '"amount":"25.5","time":1784820001000},' +
        '{"kind":"asset_receive","from":"0x00000000000000000000000000000000000000aa",' +
        '"coin":"BTC","to_perp":true,"amount":"0.5","time":1784820001000},' +
        '{"kind":"withdraw","coin":"USDC","amount":"100","chain":"base",' +
        '"via":"metabridge","destination_chain_id":8453,"time":1784820001000},' +
        '{"kind":"sub_account_transfer","sub_index":1,"deposit":true,' +
        '"amount":"10","time":1784820001000},' +
        '{"kind":"vault_transfer","vault_id":3,"deposit":false,' +
        '"amount":"10","time":1784820001000}],"is_snapshot":true}',
    );
    if (!isChannelFrame(f, 'ledger_updates')) throw new Error('narrow failed');
    const [send, recv, asset, wd, sub, vault] = f.data;
    // The direction rides `kind`; `amount` itself is unsigned. The gateway
    // REST union instead normalizes to a signed `delta`.
    expect(send!.kind).toBe('usd_send');
    expect(send!.amount).toBe('25.5');
    expect(send!.time).toBe(1_784_820_001_000);
    expect(send!.destination).toBe(
      '0x00000000000000000000000000000000000000bb',
    );
    // The USD-plane kinds carry no token symbol.
    expect(send!.coin).toBeUndefined();
    expect(recv!.from).toBe('0x00000000000000000000000000000000000000aa');
    expect(asset!.coin).toBe('BTC');
    expect(asset!.to_perp).toBe(true);
    expect(wd!.via).toBe('metabridge');
    expect(wd!.chain).toBe('base');
    expect(wd!.destination_chain_id).toBe(8453);
    expect(sub!.sub_index).toBe(1);
    expect(sub!.deposit).toBe(true);
    expect(vault!.vault_id).toBe(3);
  });

  it('the TWAP channels keep their camelCase wire keys', async () => {
    const slice = await inbound(
      '{"channel":"user_twap_slice_fills","data":[{"fill":{"coin":"BTC",' +
        '"side":"B","px":"25000","sz":"0.1","time":1784820001000,"oid":42,' +
        '"cloid":null,"tid":7,"crossed":true,"block":8416000,"hash":"0xabc"},' +
        '"twapId":9}]}',
    );
    if (!isChannelFrame(slice, 'user_twap_slice_fills')) {
      throw new Error('narrow failed');
    }
    // `twapId` is camelCase on the wire — a documented island, not a bug.
    expect(slice.data[0]!.twapId).toBe(9);
    expect(slice.data[0]!.fill.sz).toBe('0.1');

    const hist = await inbound(
      '{"channel":"user_twap_history","data":[{"time":1784820001000,' +
        '"state":{"twapId":9,"coin":"BTC","side":"B","sz":"1","executedSz":"0.4",' +
        '"minutes":30,"reduceOnly":false,"timestamp":1784820001000},' +
        '"status":{"status":"activated"}}]}',
    );
    if (!isChannelFrame(hist, 'user_twap_history')) {
      throw new Error('narrow failed');
    }
    const h = hist.data[0]!;
    // `executedSz` / `reduceOnly` stay camelCase too, and `status` is nested.
    expect(h.state.executedSz).toBe('0.4');
    expect(h.state.reduceOnly).toBe(false);
    expect(h.status.status).toBe('activated');
    // The parent id is the key `twap_cancel` needs; it appears nowhere else
    // before a fill lands.
    expect(h.state.twapId).toBe(9);
    expect(h.state.coin).toBe('BTC');
    expect(h.state.side).toBe('B');
    expect(h.state.sz).toBe('1');
    expect(h.state.minutes).toBe(30);
    expect(h.state.timestamp).toBe(1_784_820_001_000);
    expect(h.time).toBe(1_784_820_001_000);
  });

  it('spot_margin_state adds the height/time stamp the REST read omits', async () => {
    const f = await inbound(
      '{"channel":"spot_margin_state","data":{' +
        '"user":"0x00000000000000000000000000000000000000aa","accounts":[],' +
        '"height":8416000,"time":1784820001000},"is_snapshot":true}',
    );
    if (!isChannelFrame(f, 'spot_margin_state')) throw new Error('narrow failed');
    // The request/response key is `user`, NOT `address`.
    expect(f.data.user).toBe('0x00000000000000000000000000000000000000aa');
    expect(f.data.accounts).toEqual([]);
    expect(f.data.height).toBe(8_416_000);
    expect(f.data.time).toBe(1_784_820_001_000);
  });

  it('WsChannelData wires the channels that reuse an existing DTO', async () => {
    // One read per channel, so a wrong map entry fails the typecheck gate.
    const mids = await inbound(
      '{"channel":"all_mids","data":{"mids":{"BTC":"25000","MTF":"0.12126"}}}',
    );
    if (!isChannelFrame(mids, 'all_mids')) throw new Error('narrow failed');
    expect(mids.data.mids['BTC']).toBe('25000');

    const trades = await inbound(
      '{"channel":"trades","data":[{"coin":"BTC","side":"B","px":"25000",' +
        '"sz":"0.5","time":1784820001000,"tid":7,' +
        '"users":["0x00000000000000000000000000000000000000aa",' +
        '"0x00000000000000000000000000000000000000bb"],' +
        '"block":8416000,"hash":"0xabc"}]}',
    );
    if (!isChannelFrame(trades, 'trades')) throw new Error('narrow failed');
    // Taker first on a live push; a snapshot row carries `users: null`.
    expect(trades.data[0]!.users?.[0]).toBe(
      '0x00000000000000000000000000000000000000aa',
    );

    const fills = await inbound(
      '{"channel":"fills","data":[{"coin":"BTC","side":"A","px":"25000",' +
        '"sz":"0.5","time":1784820001000,"oid":42,"cloid":null,"tid":7,' +
        '"crossed":false,"block":8416000,"hash":""}]}',
    );
    if (!isChannelFrame(fills, 'fills')) throw new Error('narrow failed');
    // A maker leg carries no cloid and an empty trace hash.
    expect(fills.data[0]!.crossed).toBe(false);
    expect(fills.data[0]!.hash).toBe('');

    const updates = await inbound(
      '{"channel":"order_updates","data":[{"order":{"coin":"BTC","side":"B",' +
        '"px":"25000","sz":"0.5","orig_sz":"1","oid":42,"cloid":null,' +
        '"tif":"gtc","reduce_only":false,"trigger":null,"inserted_at":null},' +
        '"status":"open","filled_sz":"0.5","avg_px":"25000","reason":null,' +
        '"time":1784820001000}]}',
    );
    if (!isChannelFrame(updates, 'order_updates')) {
      throw new Error('narrow failed');
    }
    expect(updates.data[0]!.status).toBe('open');
    expect(updates.data[0]!.order.orig_sz).toBe('1');

    const open = await inbound(
      '{"channel":"open_orders","data":[{"oid":42,"coin":"BTC","side":"B",' +
        '"px":"25000","sz":"0.5","orig_sz":null,"cloid":null,"tif":"gtc",' +
        '"reduce_only":false,"trigger":null,"inserted_at":1784820001000}],' +
        '"is_snapshot":true}',
    );
    if (!isChannelFrame(open, 'open_orders')) throw new Error('narrow failed');
    // Every open_orders frame is a FULL snapshot of the resting set.
    expect(open.data[0]!.oid).toBe(42);
    expect(open.is_snapshot).toBe(true);

    const block = await inbound(
      '{"channel":"explorer_block","data":[{"height":8416000,"round":9,' +
        '"epoch":2,"hash":"0xabc","proposer":1,"tx_count":4,' +
        '"time":1784820001000}]}',
    );
    if (!isChannelFrame(block, 'explorer_block')) {
      throw new Error('narrow failed');
    }
    expect(block.data[0]!.tx_count).toBe(4);

    const txs = await inbound(
      '{"channel":"explorer_txs","data":[{"oid":42,' +
        '"user":"0x00000000000000000000000000000000000000aa","coin":"BTC",' +
        '"action":"open","status":0,"side":0,"side_str":"B","hash":"0xabc",' +
        '"time":1784820001000}]}',
    );
    if (!isChannelFrame(txs, 'explorer_txs')) throw new Error('narrow failed');
    expect(txs.data[0]!.side_str).toBe('B');

    const aad = await inbound(
      '{"channel":"active_asset_data","data":{' +
        '"address":"0x00000000000000000000000000000000000000aa","coin":"BTC",' +
        '"leverage":10,"margin_mode":"cross","mark_px":"25000",' +
        '"available_to_trade":["1000","1000"],"max_trade_szs":["0.04","0.04"],' +
        '"max_trade_size":"5","has_position":false}}',
    );
    if (!isChannelFrame(aad, 'active_asset_data')) {
      throw new Error('narrow failed');
    }
    expect(aad.data.margin_mode).toBe('cross');
    expect(aad.data.max_trade_szs[0]).toBe('0.04');

    const web = await inbound(
      '{"channel":"web_data","data":{' +
        '"address":"0x00000000000000000000000000000000000000aa",' +
        '"vault":{"equities":[],"vaults":[]},' +
        '"staking":{"state":{"total_staked":"0","delegations":[],' +
        '"pending_unstakes":[]},"summary":{"total_delegated":"0",' +
        '"pending_withdrawal":"0","claimable_rewards":"0","n_delegations":0}},' +
        '"sub_accounts":[],' +
        '"multisig":{"is_multi_sig":false,"threshold":0,"signers":[]},' +
        '"agents":[],"height":8416000,"time":1784820001000},' +
        '"is_snapshot":true}',
    );
    if (!isChannelFrame(web, 'web_data')) throw new Error('narrow failed');
    expect(web.data.staking.summary.n_delegations).toBe(0);
    expect(web.data.height).toBe(8_416_000);
  });

  it('isChannelFrame rejects a different channel name', async () => {
    const f = await inbound('{"channel":"trades","data":[]}');
    expect(isChannelFrame(f, 'user_fundings')).toBe(false);
    expect(isChannelFrame(f, 'trades')).toBe(true);
  });
});
