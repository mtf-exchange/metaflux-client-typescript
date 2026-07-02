// WS client wire-protocol tests — pure TS, no WASM. Drives the WsClient against
// a minimal in-process WebSocket mock and asserts the EXACT frames the server's
// `/ws` endpoint parses (snake_case native, per the KB spec
// metaflux-knowledges/api/ws/subscriptions.md):
//   {"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC"}}
//   {"method":"unsubscribe","subscription":{"type":"trades"}}
//   {"method":"ping"}
// and that inbound {"channel","data"} frames fan out to handlers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WsClient, WS_CHANNELS, type WsFrame } from '../src/ws/ws.js';

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

  it('exposes the exact 19 native gateway channel names (web_data2 GONE)', () => {
    expect([...WS_CHANNELS]).toEqual([
      'l2_book',
      'bbo',
      'trades',
      'active_asset_ctx',
      'all_mids',
      'explorer_block',
      'explorer_txs',
      'candles',
      'fills',
      'user_events',
      'order_updates',
      'notifications',
      'ledger_updates',
      'user_fundings',
      'user_twap_slice_fills',
      'user_twap_history',
      'account_state',
      'spot_state',
      'active_asset_data',
    ]);
    expect(WS_CHANNELS).not.toContain('web_data2');
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
    await expect(
      ws.postAction('{"type":"set_position_mode","params":{"hedge":true}}'),
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
