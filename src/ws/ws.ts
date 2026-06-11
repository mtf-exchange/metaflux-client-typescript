// MTF-native WebSocket client — connect, subscribe/unsubscribe, typed frames.
//
// Mirrors the Rust SDK's `WsClient` behavior (reconnect with backoff, replay of
// active subscriptions, heartbeat ping) and the SERVER wire protocol
// (per the KB spec metaflux-knowledges/api/ws/subscriptions.md):
//
//   client → server:
//     {"method":"subscribe","subscription":{"type":"l2_book","coin":"BTC"}}
//     {"method":"unsubscribe","subscription":{"type":"trades"}}
//     {"method":"ping"}
//   server → client:
//     {"channel":"subscriptionResponse","data":{"method":"subscribe","subscription":{...}}}
//     {"channel":"l2_book","data":{...}} | {"channel":"error","data":{"error":"..."}}
//
// Channel names are the EXACT server `Channel::wire_name()` strings — snake_case
// MTF-native (`l2_book`, `user_events`), since this SDK speaks MTF-native to the
// node per ADR-019. (HL SDKs use HL camelCase against the gateway `/hl/ws`.)
// `coin` is the market symbol string and is optional (`user_events` carries none).
//
// Transport: the standard `WebSocket` global (browser-native; Node ≥ 22 ships
// it globally, which is the SDK's floor). No `ws` npm dependency — keeping the
// SDK dependency-free for both runtimes.

import type { Funding } from '../types/info/core.js';

/// Channel names exactly as the server's `Channel::from_wire` accepts them
/// (snake_case MTF-native).
export type WsChannel =
  // per-market (require `coin`)
  | 'l2_book'
  | 'bbo'
  | 'trades'
  | 'active_asset_ctx'
  // global (no params)
  | 'all_mids'
  // per-market + interval (`candles` needs `coin` + `interval`)
  | 'candles'
  // per-account (require `user`)
  | 'fills'
  | 'user_events'
  | 'order_updates'
  | 'notifications'
  | 'ledger_updates'
  | 'user_fundings'
  | 'user_twap_slice_fills'
  | 'user_twap_history'
  // per-account + market (`active_asset_data` needs `user` + `coin`)
  | 'active_asset_data';

/// All known channels — handy for callers that want to subscribe broadly.
export const WS_CHANNELS: readonly WsChannel[] = [
  'l2_book',
  'bbo',
  'trades',
  'active_asset_ctx',
  'all_mids',
  'candles',
  'fills',
  'user_events',
  'order_updates',
  'notifications',
  'ledger_updates',
  'user_fundings',
  'user_twap_slice_fills',
  'user_twap_history',
  'active_asset_data',
] as const;

/// A subscription request body — the inner `subscription` object of a
/// subscribe / unsubscribe frame. The routing key is the combination of the
/// fields a channel uses:
///   - `coin`     — per-market channels (`l2_book`, `bbo`, `trades`,
///                  `active_asset_ctx`, `candles`, `active_asset_data`)
///   - `user`     — per-account channels (`fills`, `user_events`,
///                  `order_updates`, `active_asset_data`, …); the 0x address
///   - `interval` — `candles` only (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`)
/// Global channels (`all_mids`) take none.
export interface WsSubscription {
  type: WsChannel;
  coin?: string;
  user?: string;
  interval?: string;
}

/// `all_mids` payload — every market's tick-snapped whole-USDC mark, keyed by
/// coin (same plane as the REST `markets` read; no 1e8 scaling).
export interface AllMids {
  mids: Record<string, string>;
}

/// `active_asset_ctx` payload — one market's mark/oracle/funding/OI, in the
/// whole-USDC plane. `funding` is `null` for an unknown market.
export interface ActiveAssetCtx {
  coin: string;
  mark_px: string;
  oracle_px: string;
  funding: Funding | null;
  open_interest: string;
}

/// A typed inbound frame `{channel, data}`. `data` is left as `unknown` because
/// the node currently ships string-JSON payloads whose concrete shapes are
/// mid-flight server-side (see `ws/subscribe.rs` — empty snapshots today); the
/// caller narrows per channel. `subscriptionResponse` and `error` are the two
/// control frames with stable shapes.
export interface WsFrame {
  channel: string;
  data: unknown;
}

/// Handler invoked for every inbound channel frame.
export type WsMessageHandler = (frame: WsFrame) => void;

/// Tunable WS configuration — mirrors the Rust `WsConfig` defaults.
export interface WsConfig {
  /// Heartbeat interval (ms). Default: 30_000.
  pingIntervalMs: number;
  /// Initial reconnect backoff (ms). Default: 250.
  initialBackoffMs: number;
  /// Max reconnect backoff (ms). Default: 30_000.
  maxBackoffMs: number;
  /// Auto-reconnect on unexpected close. Default: true.
  autoReconnect: boolean;
}

const DEFAULT_CONFIG: WsConfig = {
  pingIntervalMs: 30_000,
  initialBackoffMs: 250,
  maxBackoffMs: 30_000,
  autoReconnect: true,
};

/// Subscription set equality key — `(channel, coin, user, interval)` is the
/// server's routing key, so two subscriptions are identical iff all match
/// (e.g. `candles` `1m` vs `5m`, or `fills` for two different users, are
/// distinct subscriptions).
function subKey(s: WsSubscription): string {
  return `${s.type}:${s.coin ?? ''}:${s.user ?? ''}:${s.interval ?? ''}`;
}

/// MTF-native WebSocket client.
///
/// Usage:
/// ```ts
/// const ws = new WsClient('wss://api.mtf.exchange/ws');
/// ws.onMessage((f) => { if (f.channel === 'l2_book') handleBook(f.data); });
/// await ws.connect();
/// await ws.subscribe({ type: 'l2_book', coin: 'BTC' });
/// // ... later
/// ws.close();
/// ```
///
/// `connect()` resolves once the socket is OPEN. Active subscriptions are
/// re-issued automatically after a reconnect. Drop with `close()`.
export class WsClient {
  private readonly url: string;
  private readonly config: WsConfig;
  private socket: WebSocket | undefined;
  /// Active subscriptions, replayed on (re)connect. Keyed for dedupe.
  private readonly active = new Map<string, WsSubscription>();
  private readonly handlers: WsMessageHandler[] = [];
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  /// True once `close()` is called — suppresses auto-reconnect.
  private closed = false;

  constructor(url: string, config: Partial<WsConfig> = {}) {
    if (url.length === 0) {
      throw new RangeError('WsClient url must be non-empty');
    }
    this.url = url;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.backoffMs = this.config.initialBackoffMs;
  }

  /// Register an inbound-frame handler. Multiple handlers fan out; each
  /// receives every frame. Returns an unsubscribe function.
  onMessage(handler: WsMessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /// Open the connection. Resolves when the socket reaches OPEN; rejects if the
  /// initial connect errors. Subsequent reconnects (if `autoReconnect`) happen
  /// transparently in the background.
  async connect(): Promise<void> {
    this.closed = false;
    await this.openOnce();
  }

  /// Subscribe to a channel. The subscription is recorded and replayed on
  /// reconnect. Idempotent — a duplicate `(channel, coin)` is a no-op (matching
  /// the server, which silently ignores duplicate subscribes).
  async subscribe(sub: WsSubscription): Promise<void> {
    const key = subKey(sub);
    if (!this.active.has(key)) {
      this.active.set(key, sub);
    }
    this.send({ method: 'subscribe', subscription: sub });
  }

  /// Unsubscribe from a channel.
  async unsubscribe(sub: WsSubscription): Promise<void> {
    this.active.delete(subKey(sub));
    this.send({ method: 'unsubscribe', subscription: sub });
  }

  /// Whether the socket is currently OPEN.
  get isOpen(): boolean {
    return this.socket?.readyState === 1; // WebSocket.OPEN
  }

  /// Close the connection and cancel auto-reconnect. After `close()` the client
  /// is inert until `connect()` is called again.
  close(): void {
    this.closed = true;
    this.clearTimers();
    if (this.socket !== undefined) {
      try {
        this.socket.close();
      } catch {
        // Already closing / closed.
      }
      this.socket = undefined;
    }
  }

  // -------------------------------------------------------------------------

  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const sock = new WebSocket(this.url);
      this.socket = sock;

      sock.onopen = () => {
        this.backoffMs = this.config.initialBackoffMs;
        // Replay active subscriptions on (re)connect.
        for (const sub of this.active.values()) {
          this.send({ method: 'subscribe', subscription: sub });
        }
        this.startPing();
        settled = true;
        resolve();
      };

      sock.onmessage = (ev: MessageEvent) => {
        this.dispatch(typeof ev.data === 'string' ? ev.data : String(ev.data));
      };

      sock.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`WsClient failed to connect to ${this.url}`));
        }
        // Post-open errors are handled by onclose → reconnect.
      };

      sock.onclose = () => {
        this.clearTimers();
        this.socket = undefined;
        if (!this.closed && this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.config.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      // Best-effort reconnect; failures retry via the next onclose.
      void this.openOnce().catch(() => {
        if (!this.closed && this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      this.send({ method: 'ping' });
    }, this.config.pingIntervalMs);
  }

  private send(obj: unknown): void {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify(obj));
    }
    // If not open, the frame is dropped; subscribe state is replayed on the
    // next open, so a dropped subscribe self-heals. A dropped ping is benign.
  }

  private dispatch(raw: string): void {
    let frame: WsFrame;
    try {
      const parsed = JSON.parse(raw) as Partial<WsFrame>;
      if (typeof parsed.channel !== 'string') return; // ignore malformed
      frame = { channel: parsed.channel, data: parsed.data };
    } catch {
      return; // ignore non-JSON frames
    }
    for (const h of this.handlers) {
      h(frame);
    }
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
