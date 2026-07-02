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
// Channel names are the EXACT server wire strings — snake_case MTF-native
// (`l2_book`, `user_events`); this SDK speaks the MTF-native surface only.
// `coin` is the market symbol string and is optional (`user_events` carries none).
//
// Transport: the standard `WebSocket` global (browser-native; Node ≥ 22 ships
// it globally, which is the SDK's floor). No `ws` npm dependency — keeping the
// SDK dependency-free for both runtimes.

import type { Funding } from '../types/info/core.js';
import type { TradeSide } from '../types/info/reads.js';
import {
  buildNativeCancelAction,
  buildNativeOrderAction,
} from '../native/actions.js';
import { nextNonce, recoverNativeSigner, signNativeAction } from '../native/digest.js';
import type {
  NativeCancel,
  NativeExchangeAck,
  NativeOrder,
} from '../types/index.js';

/// Channel names exactly as the gateway's native `/ws` surface accepts them
/// (snake_case MTF-native) — the 19 channels the gateway serves natively.
/// `web_data2` was REMOVED: compose `account_state` + `spot_state` instead.
export type WsChannel =
  // per-market (require `coin` — the market SYMBOL, e.g. "BTC")
  | 'l2_book'
  | 'bbo'
  | 'trades'
  | 'active_asset_ctx'
  // global (no params)
  | 'all_mids'
  | 'explorer_block'
  | 'explorer_txs'
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
  | 'account_state'
  | 'spot_state'
  // per-account + market (`active_asset_data` needs `user` + `coin`)
  | 'active_asset_data';

/// All known channels — handy for callers that want to subscribe broadly. The
/// exact 19 native gateway channels.
export const WS_CHANNELS: readonly WsChannel[] = [
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
] as const;

/// A subscription request body — the inner `subscription` object of a
/// subscribe / unsubscribe frame. The routing key is the combination of the
/// fields a channel uses:
///   - `coin`     — per-market channels (`l2_book`, `bbo`, `trades`,
///                  `active_asset_ctx`, `candles`, `active_asset_data`). The
///                  market SYMBOL string (`"BTC"`); a decimal asset-id string
///                  is also accepted.
///   - `user`     — per-account channels (`fills`, `user_events`,
///                  `order_updates`, `notifications`, `ledger_updates`,
///                  `user_fundings`, `user_twap_slice_fills`,
///                  `user_twap_history`, `account_state`, `spot_state`,
///                  `active_asset_data`); the 0x address.
///   - `interval` — `candles` only (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`)
/// Global channels (`all_mids`, `explorer_block`, `explorer_txs`) take none.
export interface WsSubscription {
  type: WsChannel;
  /// Market symbol (`"BTC"`); a decimal asset-id string is also accepted.
  coin?: string;
  /// User `0x`-hex address (per-account channels).
  user?: string;
  /// Bar interval token (`candles` only).
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

/// `active_asset_data` WS payload — a user's per-(user, coin) leverage /
/// margin-mode / tradeable-size snapshot. The body is the EXACT REST
/// `active_asset_data` read for the same pair, so the two never drift. Named
/// `*Frame` for continuity with earlier SDK versions.
export type ActiveAssetDataFrame = import('../types/info/index.js').ActiveAssetData;

/// One `trades` channel record. The on-subscribe snapshot is a NON-EMPTY
/// array of recent tape prints (`users: null` on snapshot rows — the
/// committed tape does not retain taker/maker); each live push is an array of
/// fresh prints with `users: [taker, maker]` (taker first, the aggressor).
export interface WsTrade {
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Taker's side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Trade price, whole-USDC decimal string.
  px: string;
  /// Trade size, whole units as a decimal string.
  sz: string;
  /// Trade timestamp (consensus ms).
  time: number;
  /// Deterministic trade id (shared by both legs of the print).
  tid: number;
  /// `[taker, maker]` 0x addresses on live pushes; `null` on snapshot rows.
  users: [string, string] | null;
  /// Committed block height the trade landed in.
  block: number;
  /// Taker action's transaction hash (`0x`-hex); empty when systemic.
  hash: string;
}

/// One `fills` channel record — the per-account leg of an executed match.
/// Both legs of one match share the `tid` the public `trades` print carries.
export interface WsFill {
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// This leg's side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Fill price, whole-USDC decimal string.
  px: string;
  /// Fill size, whole units as a decimal string.
  sz: string;
  /// Fill timestamp (consensus ms).
  time: number;
  /// This party's order id.
  oid: number;
  /// Client order id (`0x`-hex); `null` on maker legs and snapshot rows.
  cloid: string | null;
  /// Deterministic trade id.
  tid: number;
  /// `true` on the taker (aggressor) leg, `false` on the maker leg; `null` on
  /// snapshot rows (the committed tape does not retain the role).
  crossed: boolean | null;
  /// Committed block height.
  block: number;
  /// Originating action's transaction hash (`0x`-hex); empty on maker legs.
  hash: string;
}

/// The `order` object inside a `WsOrderUpdate`. Fields the event kind does
/// not carry are `null`, so one shape decodes every lifecycle record.
export interface WsOrderUpdateOrder {
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Side token (`"B"` / `"A"`), or `null` when unknown.
  side: TradeSide | null;
  /// Limit price, whole-USDC decimal string, or `null`.
  limit_px: string | null;
  /// REMAINING size after the commit (whole units), or `null`. On a `filled`
  /// record this is `orig_sz − filled_sz`; the filled amount itself rides the
  /// top-level `filled_sz`.
  sz: string | null;
  /// Original order size (whole units), or `null`.
  orig_sz: string | null;
  /// Order id; `null` on a rejected placement.
  oid: number | null;
  /// Client order id (`0x`-hex), or `null`.
  cloid: string | null;
  /// Time-in-force label (e.g. `"GTC"`), or `null`.
  tif: string | null;
  /// Reduce-only flag, or `null`.
  reduce_only: boolean | null;
}

/// One `order_updates` channel record — per-account order lifecycle. Each
/// push is an array of records; the initial snapshot is `[]`.
export interface WsOrderUpdate {
  /// The order's fixed-shape body.
  order: WsOrderUpdateOrder;
  /// Lifecycle state. `open` = resting (`order.sz` is the book remainder);
  /// `filled` = taker completion (cumulative `filled_sz` + `avg_px`; a maker
  /// leg reports per-match `filled_sz` with `status` still `open` while size
  /// rests); `rejected` carries `reason` + null `oid`.
  status: 'open' | 'filled' | 'canceled' | 'rejected' | 'cancel_rejected';
  /// Filled size (whole units decimal string), or `null`.
  filled_sz: string | null;
  /// Average fill price (whole-USDC decimal string), or `null`.
  avg_px: string | null;
  /// Rejection reason, or `null`.
  reason: string | null;
  /// Record timestamp (consensus ms).
  time: number;
}

/// One `user_fundings` channel record — a realized funding payment.
export interface WsUserFunding {
  /// Numeric asset id the payment settled on (resolve symbols via `markets`).
  coin: number;
  /// Signed whole-USDC payment (`+` received / `−` paid), decimal string.
  payment: string;
  /// Signed position size at settlement, whole units as a decimal string.
  szi: string;
  /// Per-hour rate applied at that settlement, decimal string.
  fundingRate: string;
  /// Settlement timestamp (consensus ms).
  time: number;
}

/// One `explorer_block` channel record — a committed-block head. Each frame
/// is an array of heads (usually one).
export interface ExplorerBlock {
  /// Committed block height.
  height: number;
  /// Consensus round.
  round: number;
  /// Epoch.
  epoch: number;
  /// Lowercase 0x block hash.
  hash: string;
  /// Leader's validator-set index.
  proposer: number;
  /// Decoded transaction count.
  tx_count: number;
  /// Block timestamp (consensus ms).
  time: number;
}

/// One `explorer_txs` channel record — the global order-status firehose row.
export interface ExplorerTx {
  /// Order id (`0` on a rejected placement).
  oid: number;
  /// Acting account address (0x).
  user: string;
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Compact lifecycle label: `"open"` / `"filled"` / `"rejected"`.
  action: string;
  /// Stable status code: 0 = open, 1 = filled, 2 = rejected.
  status: number;
  /// Side code: 0 = bid, 1 = ask.
  side: number;
  /// Side token (`"B"` / `"A"`), matching the trade tape.
  side_str: TradeSide;
  /// Originating action's transaction hash (`0x`-hex); empty when systemic.
  hash: string;
  /// Record timestamp (consensus ms).
  time: number;
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
  /// How long a `post` request waits for its correlated response before failing
  /// (ms). Mirrors the Rust `post_timeout` (10 s). Default: 10_000.
  postTimeoutMs: number;
}

const DEFAULT_CONFIG: WsConfig = {
  pingIntervalMs: 30_000,
  initialBackoffMs: 250,
  maxBackoffMs: 30_000,
  autoReconnect: true,
  postTimeoutMs: 10_000,
};

/// Signing context for the WS `post` exchange path — a 32-byte private key and
/// the EIP-712 chain id to sign against. When absent, `postAction` / `submitOrder`
/// / `cancelOrder` throw; `postInfo` (an unsigned read) still works.
export interface WsSigner {
  /// 32-byte ECDSA private key.
  privateKey: Uint8Array;
  /// EIP-712 domain chain id. Defaults to `MTF_CHAIN_ID` (testnet 114514) when
  /// omitted, matching the REST `/exchange` path.
  chainId?: number;
}

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
  private readonly signer: WsSigner | undefined;
  private socket: WebSocket | undefined;
  /// Active subscriptions, replayed on (re)connect. Keyed for dedupe.
  private readonly active = new Map<string, WsSubscription>();
  private readonly handlers: WsMessageHandler[] = [];
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  /// True once `close()` is called — suppresses auto-reconnect.
  private closed = false;
  /// Monotonic id source for `post` request/response correlation.
  private postIdSeq = 1;
  /// In-flight `post` requests keyed by correlation id. Resolved when the
  /// `{channel:"post"}` frame with the matching `data.id` arrives, or rejected
  /// on timeout. A connection drop leaves them pending; the per-request timeout
  /// is the backstop (a signed action is one-shot, so we never auto-retry).
  private readonly pendingPosts = new Map<
    number,
    {
      resolve: (response: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /// In-flight `ping()` calls (FIFO) — each resolved with the round-trip time in
  /// milliseconds when the next bare `pong` frame arrives, or rejected on timeout.
  private readonly pendingPings: Array<{
    resolve: (ms: number) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    t0: number;
  }> = [];

  constructor(url: string, config: Partial<WsConfig> = {}, signer?: WsSigner) {
    if (url.length === 0) {
      throw new RangeError('WsClient url must be non-empty');
    }
    if (signer !== undefined && signer.privateKey.length !== 32) {
      throw new RangeError('WsClient signer privateKey must be exactly 32 bytes');
    }
    this.url = url;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.signer = signer;
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

  // ── convenience subscribe helpers ─────────────────────────────────────────
  //
  // `coin` is the market SYMBOL string (e.g. `"BTC"`) — the canonical key on
  // the consolidated surface. A decimal asset-id string is also accepted.

  /// Subscribe to L2 book updates for a market.
  async subscribeL2Book(coin: string): Promise<void> {
    return this.subscribe({ type: 'l2_book', coin });
  }

  /// Subscribe to public trades for a market. The on-subscribe snapshot is a
  /// non-empty array of recent tape prints (`users: null` on snapshot rows).
  async subscribeTrades(coin: string): Promise<void> {
    return this.subscribe({ type: 'trades', coin });
  }

  /// Subscribe to best-bid-best-offer ticks for a market.
  async subscribeBbo(coin: string): Promise<void> {
    return this.subscribe({ type: 'bbo', coin });
  }

  /// Subscribe to per-market mark / oracle / funding / OI context.
  async subscribeActiveAssetCtx(coin: string): Promise<void> {
    return this.subscribe({ type: 'active_asset_ctx', coin });
  }

  /// Subscribe to OHLCV candles for a market + interval token.
  async subscribeCandles(coin: string, interval: string): Promise<void> {
    return this.subscribe({ type: 'candles', coin, interval });
  }

  /// Subscribe to the global all-market mids stream.
  async subscribeAllMids(): Promise<void> {
    return this.subscribe({ type: 'all_mids' });
  }

  /// Subscribe to the global committed-block head tape.
  async subscribeExplorerBlock(): Promise<void> {
    return this.subscribe({ type: 'explorer_block' });
  }

  /// Subscribe to the global transaction (order-status) tape. Rows carry the
  /// originating action's `hash`.
  async subscribeExplorerTxs(): Promise<void> {
    return this.subscribe({ type: 'explorer_txs' });
  }

  /// Subscribe to per-user fills (0x address).
  async subscribeFills(user: string): Promise<void> {
    return this.subscribe({ type: 'fills', user });
  }

  /// Subscribe to per-user order lifecycle updates (0x address).
  async subscribeOrderUpdates(user: string): Promise<void> {
    return this.subscribe({ type: 'order_updates', user });
  }

  /// Subscribe to per-user account / margin events (0x address).
  async subscribeUserEvents(user: string): Promise<void> {
    return this.subscribe({ type: 'user_events', user });
  }

  /// Subscribe to per-user money movement (deposit / withdraw / transfer).
  async subscribeLedgerUpdates(user: string): Promise<void> {
    return this.subscribe({ type: 'ledger_updates', user });
  }

  /// Subscribe to per-user realized funding payments (0x address).
  async subscribeUserFundings(user: string): Promise<void> {
    return this.subscribe({ type: 'user_fundings', user });
  }

  /// Subscribe to the per-user live PERP account-state stream (0x address).
  /// With `spot_state`, this replaces the removed `web_data2` composite.
  async subscribeAccountState(user: string): Promise<void> {
    return this.subscribe({ type: 'account_state', user });
  }

  /// Subscribe to the per-user live SPOT clearinghouse-state stream (0x address).
  async subscribeSpotState(user: string): Promise<void> {
    return this.subscribe({ type: 'spot_state', user });
  }

  /// Subscribe to per-(user, market) leverage / margin-mode context.
  async subscribeActiveAssetData(user: string, coin: string): Promise<void> {
    return this.subscribe({ type: 'active_asset_data', coin, user });
  }

  // ── `post` request/response (signed exchange actions + info reads) ─────────
  //
  // The WS analogue of `POST /exchange` and `POST /info`: multiplex one-off
  // writes / reads over the existing socket instead of opening a REST request.
  //
  //   client → server:
  //     {"method":"post","id":N,"request":{"type":"action"|"info","payload":{...}}}
  //   server → client:
  //     {"channel":"post","data":{"id":N,"response":{"type":...,"payload":{...}}}}
  //
  // For an `action`, payload is the signed envelope `{signature, nonce, action}`
  // — signed with the SAME EIP-712 digest the REST `/exchange` path uses (the
  // node recovers the signer over the raw `action` bytes). Correlated by `id`;
  // a `{type:"error"}` response surfaces as an error; each request has a timeout.

  /// Issue a signed exchange action over the WS `post` channel, returning the
  /// node's action response payload. Requires a `WsSigner` (passed to the
  /// constructor, or via `Client.connectWs` with a keyed client).
  async postAction(actionJson: string): Promise<unknown> {
    if (this.signer === undefined) {
      throw new Error(
        'postAction requires a WsSigner (this WsClient was opened read-only)',
      );
    }
    const nonce = nextNonce();
    const signed = await signNativeAction(
      this.signer.privateKey,
      actionJson,
      nonce,
      this.signer.chainId,
    );
    // The signed envelope mirrors the REST body shape, but the `action` rides as
    // a parsed object inside the JSON `request.payload`. The server still
    // verifies over the raw `action` bytes; since the bytes we signed are valid
    // JSON, re-embedding them as `JSON.parse(actionJson)` is byte-equivalent to
    // the canonical form the server re-serializes for the digest.
    const payload = {
      signature: signed.signature,
      nonce: Number(signed.nonce),
      action: JSON.parse(actionJson) as unknown,
    };
    return this.postRequest('action', payload);
  }

  /// Issue an `info` read over the WS `post` channel, returning the info response
  /// payload. `payload` is the usual `{"type":"<info>",...}` body. No signing.
  async postInfo(payload: { type: string; [k: string]: unknown }): Promise<unknown> {
    return this.postRequest('info', payload);
  }

  /// Submit a limit / market / trigger order over the WS `post` channel.
  /// Mirrors `Client.submitOrderNative`: `order.owner` MUST equal the signing
  /// wallet (recovered locally and rejected on mismatch).
  async submitOrder(order: NativeOrder): Promise<NativeExchangeAck> {
    if (this.signer === undefined) {
      throw new Error('submitOrder requires a WsSigner (read-only WsClient)');
    }
    const actionJson = buildNativeOrderAction(order);
    await this.assertOwner(actionJson, order.owner, 'order.owner');
    return (await this.postAction(actionJson)) as NativeExchangeAck;
  }

  /// Cancel an order over the WS `post` channel. Mirrors
  /// `Client.cancelOrderNative`: `cancel.owner` MUST equal the signing wallet.
  async cancelOrder(cancel: NativeCancel): Promise<NativeExchangeAck> {
    if (this.signer === undefined) {
      throw new Error('cancelOrder requires a WsSigner (read-only WsClient)');
    }
    const actionJson = buildNativeCancelAction(cancel);
    await this.assertOwner(actionJson, cancel.owner, 'cancel.owner');
    return (await this.postAction(actionJson)) as NativeExchangeAck;
  }

  /// Recover the signer over the action's own digest and reject unless it equals
  /// `owner`. Saves a round-trip on an obvious key/owner mismatch (the server
  /// enforces the same). Shares the nonce-agnostic recover path with the REST
  /// client.
  private async assertOwner(
    actionJson: string,
    owner: string,
    field: string,
  ): Promise<void> {
    // recoverNativeSigner is nonce-agnostic for the address it yields; use a
    // throwaway nonce of 0 just to drive the digest+recover.
    const signed = await signNativeAction(
      this.signer!.privateKey,
      actionJson,
      0n,
      this.signer!.chainId,
    );
    const signer = await recoverNativeSigner(signed, this.signer!.chainId);
    if (signer.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`${field} ${owner} != recovered signer ${signer}`);
    }
  }

  /// Core `post` machinery: assign a correlation id, ship the frame, and await
  /// the matching response. Rejects on a `{type:"error"}` response, on timeout,
  /// or if the socket is not open. Returns the inner `payload` on success.
  private postRequest(
    requestType: 'action' | 'info',
    payload: unknown,
  ): Promise<unknown> {
    if (this.socket?.readyState !== 1) {
      return Promise.reject(new Error('ws post: socket is not open'));
    }
    const id = this.postIdSeq++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPosts.delete(id);
        reject(new Error('ws post: timed out'));
      }, this.config.postTimeoutMs);

      this.pendingPosts.set(id, {
        resolve: (response: unknown) => {
          // The node wraps every reply as `{type, payload}`; an error reply
          // carries the message as a string `payload`.
          if (
            response !== null &&
            typeof response === 'object' &&
            (response as { type?: unknown }).type === 'error'
          ) {
            const msg = (response as { payload?: unknown }).payload;
            reject(
              new Error(
                `ws post error: ${typeof msg === 'string' ? msg : 'unknown post error'}`,
              ),
            );
            return;
          }
          const inner =
            response !== null && typeof response === 'object'
              ? (response as { payload?: unknown }).payload
              : undefined;
          resolve(inner);
        },
        reject,
        timer,
      });

      this.send({
        method: 'post',
        id,
        request: { type: requestType, payload },
      });
    });
  }

  /// Round-trip latency probe: send a `{method:"ping"}` and resolve with the
  /// elapsed milliseconds when the node's `pong` frame returns. Rejects if the
  /// socket is not open or no pong arrives within `postTimeoutMs`. Pongs are
  /// unkeyed, so concurrent pings are paired to pongs in FIFO order.
  ping(): Promise<number> {
    if (this.socket?.readyState !== 1) {
      return Promise.reject(new Error('ws ping: socket is not open'));
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pendingPings.findIndex((p) => p.resolve === resolve);
        if (i >= 0) this.pendingPings.splice(i, 1);
        reject(new Error('ws ping: timed out'));
      }, this.config.postTimeoutMs);
      this.pendingPings.push({ resolve, reject, timer, t0 });
      this.send({ method: 'ping' });
    });
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
    // Fail any in-flight `post` so a caller awaiting a response on a socket we
    // just closed unblocks with an error rather than hanging until timeout.
    for (const [, pending] of this.pendingPosts) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ws post: client closed'));
    }
    this.pendingPosts.clear();
    // Unblock any in-flight pings on a closed socket.
    for (const pending of this.pendingPings) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ws ping: client closed'));
    }
    this.pendingPings.length = 0;
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
    // A `{channel:"post"}` frame correlates by id back to the waiting caller and
    // is consumed here — it does NOT fan out to subscription handlers. Every
    // other frame (data channels, subscriptionResponse ack, error, bare pong)
    // is passed through to the registered handlers unchanged.
    if (frame.channel === 'post') {
      this.resolvePost(frame.data);
      return;
    }
    // A bare `pong` resolves the oldest in-flight ping() with its round-trip
    // time, then still fans out to handlers (preserves the pong pass-through).
    if (frame.channel === 'pong') {
      this.resolvePong();
    }
    for (const h of this.handlers) {
      h(frame);
    }
  }

  /// Resolve the pending `post` whose id matches the frame's `data.id`. The node
  /// wraps every reply as `data.response = {type, payload}`; a `{type:"error"}`
  /// response surfaces as a rejection.
  private resolvePost(data: unknown): void {
    if (data === null || typeof data !== 'object') return;
    const { id, response } = data as { id?: unknown; response?: unknown };
    if (typeof id !== 'number') return;
    const pending = this.pendingPosts.get(id);
    if (pending === undefined) return;
    this.pendingPosts.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  /// Resolve the oldest pending `ping()` with its round-trip time (ms). Pongs are
  /// unkeyed, so FIFO order pairs each pong with the oldest outstanding ping.
  private resolvePong(): void {
    const pending = this.pendingPings.shift();
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    pending.resolve(Math.round(now - pending.t0));
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
