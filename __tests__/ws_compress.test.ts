// WS compression: golden-bytes decode, subprotocol mode selection, and the
// compatibility rule that a client which offers nothing still reads text.
//
// The golden frame is a real captured `l2_book` frame compressed by the zstd
// CLI at the wire contract's level 3 with no dictionary. The SAME bytes are a
// fixture in the Rust SDK, so a pass in both proves the two decoders agree
// with one encoder. No live endpoint speaks this protocol yet, so a golden is
// the only proof available.

import { createHash } from 'node:crypto';
import { decompress } from 'fzstd';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WsClient, type WsFrame } from '../src/ws/ws.js';

const ZSTD_PROTOCOL = 'mtf-zstd.v1';

/// zstd frame, level 3, no dictionary. 341 bytes.
const GOLDEN_ZSTD_HEX =
  '28b52ffd6448053d0a0086d031206069d3068873e81bc5b69ee8b67d7b7f15c183d3' +
  '4864f7d2ca04d99082208a0b2e00250023005f5760fcd8fa7287c1b0de284942a2fc' +
  '3c4000e0ebcb8249dcb18e3410829f1730cc00e294af2bc9b2208ac41d017b880c71' +
  '916254d8ab144a978c34331173a6354a5494cee3aab60aa5af2f343f37b4a9bc01a8' +
  'ac8f53e7a566b5568bc89dcab896964d53fb1c58f77637790f7b53ea4d8758d9d9a9' +
  '8f04e1a0b1de60140d03591a44b3f8796c6eeb6132e6b5f5c460d1f8391c5a55715e' +
  '4a3cd5acb075395d3320d0626a460f0d4b8624e4b0899c14f0df8334c821cb1d741d' +
  'cef21892241945876c72a80fe4f040eab0511943a27588e91814a8a77cd461c1819f' +
  'c4c43a64cc81e73a7cc6613cf24507aed78cf3c21b3f3b44d5e408c5217b31620fc8' +
  '9118b5bdc9611c8f9a518b0189a725477dd48f1a463d1ff10e81335b9a851920e2d6' +
  'd1';

/// The exact JSON the golden frame decompresses to. 1608 bytes.
const GOLDEN_JSON =
  '{"channel":"l2_book","data":{"coin":"BTC","levels":[[{"n":1,"px":"78' +
  '657.1","sz":"0.47166"},{"n":1,"px":"78650.6","sz":"0.47166"},{"n":1,' +
  '"px":"78635.9","sz":"0.47166"},{"n":1,"px":"78615","sz":"0.47166"},{' +
  '"n":1,"px":"78588.5","sz":"0.47166"},{"n":1,"px":"78556.8","sz":"0.4' +
  '7166"},{"n":1,"px":"78520.4","sz":"0.47166"},{"n":1,"px":"78479.4","' +
  'sz":"0.47166"},{"n":1,"px":"78434.1","sz":"0.47166"},{"n":1,"px":"78' +
  '384.7","sz":"0.47166"},{"n":1,"px":"78331.3","sz":"0.47166"},{"n":1,' +
  '"px":"78274","sz":"0.47166"},{"n":1,"px":"78212.9","sz":"0.47166"},{' +
  '"n":1,"px":"78148.2","sz":"0.47166"},{"n":1,"px":"78079.9","sz":"0.4' +
  '7166"},{"n":1,"px":"78008","sz":"0.47166"},{"n":1,"px":"77932.8","sz' +
  '":"0.47166"},{"n":1,"px":"77854.1","sz":"0.47166"},{"n":1,"px":"7777' +
  '2.2","sz":"0.47166"},{"n":1,"px":"77687","sz":"0.47166"}],[{"n":1,"p' +
  'x":"78696.5","sz":"0.45618"},{"n":1,"px":"78703","sz":"0.45618"},{"n' +
  '":1,"px":"78717.6","sz":"0.45618"},{"n":1,"px":"78738.6","sz":"0.456' +
  '18"},{"n":1,"px":"78765.1","sz":"0.45618"},{"n":1,"px":"78796.8","sz' +
  '":"0.45618"},{"n":1,"px":"78833.2","sz":"0.45618"},{"n":1,"px":"7887' +
  '4.2","sz":"0.45618"},{"n":1,"px":"78919.4","sz":"0.45618"},{"n":1,"p' +
  'x":"78968.9","sz":"0.45618"},{"n":1,"px":"79025.2","sz":"0.45618"},{' +
  '"n":1,"px":"79082.5","sz":"0.45618"},{"n":1,"px":"79143.5","sz":"0.4' +
  '5618"},{"n":1,"px":"79208.3","sz":"0.45618"},{"n":1,"px":"79276.6","' +
  'sz":"0.45618"},{"n":1,"px":"79348.4","sz":"0.45618"},{"n":1,"px":"79' +
  '423.7","sz":"0.45618"},{"n":1,"px":"79502.3","sz":"0.45618"},{"n":1,' +
  '"px":"79584.3","sz":"0.45618"},{"n":1,"px":"79669.5","sz":"0.45618"}' +
  ']],"time":1788103269757},"is_snapshot":true}';

/// sha256 pins. A fixture that fails these is not the shared fixture, so every
/// assertion after it proves nothing.
const GOLDEN_ZSTD_SHA256 =
  '2e9ba181a8c7402e740623c500e0e9d64de700ba8ca61ed1cc4527d7020e1635';
const GOLDEN_JSON_SHA256 =
  '6d85190759e57b947f865d5411ea5ff4234727d9d07f942817e3a0cc0e4406f7';

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/// WebSocket stand-in that records the offered subprotocols, answers with the
/// one the test picked, and can inject text or binary frames.
class MockSocket {
  static instances: MockSocket[] = [];
  static grant = '';
  readyState = 0;
  binaryType = 'blob';
  protocol = '';
  sent: string[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: (() => void) | undefined;

  constructor(
    public readonly url: string,
    public readonly protocols: string[] = [],
  ) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.protocol = MockSocket.grant;
    this.onopen?.();
  }

  inboundText(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  inboundBinary(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
  }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockSocket.instances = [];
  MockSocket.grant = '';
  (globalThis as { WebSocket: unknown }).WebSocket =
    MockSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = RealWebSocket;
});

describe('ws compression golden bytes', () => {
  it('the embedded fixture is the shared fixture', () => {
    expect(sha256(fromHex(GOLDEN_ZSTD_HEX))).toBe(GOLDEN_ZSTD_SHA256);
    expect(sha256(new TextEncoder().encode(GOLDEN_JSON))).toBe(
      GOLDEN_JSON_SHA256,
    );
    expect(fromHex(GOLDEN_ZSTD_HEX).length).toBe(341);
    expect(GOLDEN_JSON.length).toBe(1608);
  });

  it('decodes the golden frame to the byte-identical JSON', () => {
    const out = decompress(fromHex(GOLDEN_ZSTD_HEX));
    expect(new TextDecoder().decode(out)).toBe(GOLDEN_JSON);
    expect(sha256(out)).toBe(GOLDEN_JSON_SHA256);
  });
});

describe('ws subprotocol negotiation', () => {
  it('offers the zstd token and decodes a binary frame when granted', async () => {
    MockSocket.grant = ZSTD_PROTOCOL;
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const frames: WsFrame[] = [];
    ws.onMessage((f) => frames.push(f));
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    expect(sock.protocols).toEqual([ZSTD_PROTOCOL]);
    expect(sock.binaryType).toBe('arraybuffer');
    sock.open();
    await p;

    sock.inboundBinary(fromHex(GOLDEN_ZSTD_HEX));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.channel).toBe('l2_book');
    expect(JSON.stringify(frames[0]!.data)).toBe(
      JSON.stringify(JSON.parse(GOLDEN_JSON).data),
    );
    ws.close();
  });

  it('drops a binary frame when the server granted no token', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const frames: WsFrame[] = [];
    ws.onMessage((f) => frames.push(f));
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    sock.inboundBinary(fromHex(GOLDEN_ZSTD_HEX));
    expect(frames).toHaveLength(0);
    sock.inboundText(GOLDEN_JSON);
    expect(frames).toHaveLength(1);
    ws.close();
  });

  it('ignores a corrupt binary frame and keeps the connection', async () => {
    MockSocket.grant = ZSTD_PROTOCOL;
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const frames: WsFrame[] = [];
    ws.onMessage((f) => frames.push(f));
    const p = ws.connect();
    const sock = MockSocket.instances[0]!;
    sock.open();
    await p;

    sock.inboundBinary(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]));
    expect(frames).toHaveLength(0);
    sock.inboundBinary(fromHex(GOLDEN_ZSTD_HEX));
    expect(frames).toHaveLength(1);
    ws.close();
  });
});

describe('ws compatibility with a server that has no compression', () => {
  // A server which grants no subprotocol makes the client fail the handshake.
  // The client must fall back and connect, or this change breaks every live
  // endpoint.
  it('retries with no offer and reads text frames as before', async () => {
    const ws = new WsClient('wss://x/ws', { autoReconnect: false });
    const frames: WsFrame[] = [];
    ws.onMessage((f) => frames.push(f));
    const p = ws.connect();

    const first = MockSocket.instances[0]!;
    expect(first.protocols).toEqual([ZSTD_PROTOCOL]);
    first.close(); // Closed before open: the handshake failed.

    const second = MockSocket.instances[1]!;
    expect(second.protocols).toEqual([]);
    second.open();
    await p;
    expect(ws.isOpen).toBe(true);

    await ws.subscribe({ type: 'l2_book', coin: 'BTC' });
    expect(second.sent).toContain(
      '{"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC"}}',
    );
    second.inboundText(GOLDEN_JSON);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.channel).toBe('l2_book');
    expect(frames[0]!.is_snapshot).toBe(true);
    ws.close();
  });
});
