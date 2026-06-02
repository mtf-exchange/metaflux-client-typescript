// WS client wire-protocol tests — pure TS, no WASM. Drives the WsClient against
// a minimal in-process WebSocket mock and asserts the EXACT frames the server
// (`metaflux/crates/api-node/src/ws/subscribe.rs`) parses:
//   {"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC"}}
//   {"method":"unsubscribe","subscription":{"type":"trades"}}
//   {"method":"ping"}
// and that inbound {"channel","data"} frames fan out to handlers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WsClient, WS_CHANNELS } from '../src/ws.js';

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

    await ws.subscribe({ type: 'l2Book', coin: 'BTC' });
    expect(sock.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC"}}',
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
    sock.inbound('{"channel":"l2Book","data":{"coin":"BTC","levels":[[],[]]}}');
    sock.inbound('{"channel":"error","data":{"error":"bad channel"}}');

    expect(got).toHaveLength(2);
    expect(got[0]!.channel).toBe('l2Book');
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

  it('exposes the exact server channel names', () => {
    expect([...WS_CHANNELS]).toEqual([
      'l2Book',
      'trades',
      'bbo',
      'fills',
      'candles',
      'userEvents',
    ]);
  });
});
