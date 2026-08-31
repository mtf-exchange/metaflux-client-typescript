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
// (`l2_book`, `order_updates`); this SDK speaks the MTF-native surface only.
// `coin` is the market symbol string and is optional (account channels carry none).
//
// Transport: the standard `WebSocket` global (browser-native; Node ≥ 22 ships
// it globally, which is the SDK's floor). No `ws` npm dependency — the same
// code runs in both runtimes.
//
// Compression: the client offers the `mtf-zstd.v1` subprotocol. The server
// echoes the token it selected, so the mode is known before the first frame.
// With the token selected, a BINARY frame is one zstd frame whose decompressed
// payload is exactly the JSON text; TEXT frames stay plain JSON, and control
// frames stay TEXT in every mode. With no token selected the stream is plain
// text, exactly as before. Outbound frames are always text.
//
// A server that grants no subprotocol makes the client FAIL the handshake (the
// WebSocket standard requires this). So a socket that offered the token and
// closed before it opened retries at once with no offer, and every later
// attempt from this client offers nothing.

import type {
  AccountState,
  ClearinghouseState,
  Funding,
  MarketKind,
  SpotMarginState,
} from '../types/info/core.js';
import type { OptionState } from '../types/info/options.js';
import type {
  Candle,
  CandleType,
  L2BookParams,
  OpenOrder,
  OrderTif,
  OrderTrigger,
  TradeSide,
} from '../types/info/reads.js';
import {
  buildNativeCancelAction,
  buildNativeOrderAction,
} from '../native/actions.js';
import { nextNonce } from '../native/digest.js';
import { signTypedAction } from '../native/typed.js';
import {
  signTypedOrder,
  type TypedOrderPayload,
} from '../native/typed_orders.js';
import type {
  NativeCancel,
  NativeExchangeAck,
  NativeOrder,
} from '../types/index.js';
import { decompress } from 'fzstd';

/// Subprotocol token for zstd binary frames without a dictionary. The gateway
/// also serves a dictionary token; this SDK does not offer it, because no pure
/// JavaScript decoder accepts a raw zstd dictionary.
const ZSTD_PROTOCOL = 'mtf-zstd.v1';

const UTF8 = new TextDecoder();

/// Channel names exactly as the gateway's native `/ws` surface accepts them
/// (snake_case MTF-native) — the channels the gateway serves natively.
///
/// RETIRED, and refused with the error envelope: `web_data2`, `spot_state`,
/// `web_data`, `all_mids`, `active_asset_ctx` and `user_events`. Each
/// duplicated a channel that is still here, so a client had to pick and a wrong
/// pick was silent. Subscribe to `markets` for what `all_mids` and
/// `active_asset_ctx` carried; to `fills` / `order_updates` / `ledger_updates`
/// / `notifications` for what `user_events` carried; poll the REST
/// `account_state` `detail: "overview"` read for what `web_data` carried.
export type WsChannel =
  // per-market (require `coin` — the market SYMBOL, e.g. "BTC")
  | 'l2_book'
  | 'bbo'
  | 'trades'
  // global (no params)
  | 'markets'
  // per-market + interval (`candles` needs `coin` + `interval`)
  | 'candles'
  // per-account (require `user`)
  | 'fills'
  | 'order_updates'
  | 'open_orders'
  | 'notifications'
  | 'ledger_updates'
  | 'user_fundings'
  | 'user_twap_slice_fills'
  | 'user_twap_history'
  | 'account_state'
  | 'clearinghouse_state'
  | 'option_state'
  | 'spot_margin_state'
  // per-account + market (`active_asset_data` needs `user` + `coin`)
  | 'active_asset_data';

/// All known channels — handy for callers that want to subscribe broadly.
export const WS_CHANNELS: readonly WsChannel[] = [
  'l2_book',
  'bbo',
  'trades',
  'markets',
  'candles',
  'fills',
  'order_updates',
  'open_orders',
  'notifications',
  'ledger_updates',
  'user_fundings',
  'user_twap_slice_fills',
  'user_twap_history',
  'account_state',
  'clearinghouse_state',
  'option_state',
  'spot_margin_state',
  'active_asset_data',
] as const;

/// A subscription request body — the inner `subscription` object of a
/// subscribe / unsubscribe frame. The routing key is the combination of the
/// fields a channel uses:
///   - `coin`     — per-market channels (`l2_book`, `bbo`, `trades`,
///                  `candles`, `active_asset_data`). The market SYMBOL string
///                  (`"BTC"`); a decimal asset-id string is also accepted.
///   - `user`     — per-account channels (`fills`, `order_updates`,
///                  `open_orders`, `notifications`, `ledger_updates`,
///                  `user_fundings`, `user_twap_slice_fills`,
///                  `user_twap_history`, `account_state`,
///                  `clearinghouse_state`, `option_state`,
///                  `spot_margin_state`, `active_asset_data`); the 0x address.
///   - `interval` — `candles` only (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`)
///   - `candle_type` — `candles` only (`mark` / `oracle`)
/// Global channels (`markets`) take none.
///
/// `candles` routes on all three of `coin`, `interval` and `candle_type`, so
/// `mark` and `oracle` at one interval are independent subscriptions.
export interface WsSubscription {
  type: WsChannel;
  /// Market symbol (`"BTC"`); a decimal asset-id string is also accepted. For
  /// `l2_book`, a spot pair NAME (`"BTC/USDC"`) or pair id is also accepted and
  /// now renders real depth.
  coin?: string;
  /// User `0x`-hex address (per-account channels).
  user?: string;
  /// Bar interval token (`candles` only).
  interval?: string;
  /// Price series (`candles` on the GATEWAY mount only): `mark` (the DEFAULT,
  /// perp and spot) or `oracle` (perp only). The ack echoes the applied value.
  /// The retired `trade` series is rejected, never substituted. Sent verbatim,
  /// so the key MUST stay snake_case.
  candle_type?: CandleType;
  /// `l2_book` only — HL-style depth grouping: significant figures 2..=5. The
  /// object is serialized verbatim into the subscribe frame, so these MUST stay
  /// snake_case (the gateway's native `/ws` parser reads only snake_case).
  n_sig_figs?: number;
  /// `l2_book` only — sub-figure mantissa bucket `1`|`2`|`5`; valid only with
  /// `n_sig_figs === 5`. The ack echoes it ONLY when ≠ 1.
  mantissa?: number;
  /// `l2_book` only — max levels per side (≥ 1); the load-reduction lever.
  n_levels?: number;
}

/// `active_asset_data` WS payload — a user's per-(user, coin) leverage /
/// margin-mode / tradeable-size snapshot. The body is the EXACT REST
/// `active_asset_data` read for the same pair, so the two never drift. Named
/// `*Frame` for continuity with earlier SDK versions.
export type ActiveAssetDataFrame = import('../types/info/index.js').ActiveAssetData;

/// One `trades` channel record. The on-subscribe snapshot is a NON-EMPTY
/// array of recent tape prints (`users: null` on snapshot rows — the
/// committed tape does not retain taker/maker); each live push is an array of
/// fresh prints with `users: [taker]` — the aggressor only. The resting
/// maker is never disclosed.
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
  ///
  /// A decimal-digit STRING. It is a 64-bit hash-derived value that routinely
  /// exceeds `Number.MAX_SAFE_INTEGER`, so a JSON number would silently lose
  /// its low digits. Compare it as a string, or convert with `BigInt`.
  tid: string;
  /// `[taker, maker]` 0x addresses on live pushes; `null` on snapshot rows.
  users: [string] | null;
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
  /// This party's order id, a decimal-digit STRING.
  oid: string;
  /// Client order id (`0x`-hex); `null` on maker legs and snapshot rows.
  cloid: string | null;
  /// Deterministic trade id, a decimal-digit STRING — it exceeds
  /// `Number.MAX_SAFE_INTEGER`. Join fills to trades by string equality.
  tid: string;
  /// `true` on the taker (aggressor) leg, `false` on the maker leg; `null` on
  /// snapshot rows (the committed tape does not retain the role).
  crossed: boolean | null;
  /// Committed block height.
  block: number;
  /// Originating action's transaction hash (`0x`-hex); empty on maker legs.
  hash: string;
}

/// The `order` object inside a `WsOrderUpdate` — the SAME canonical row the
/// REST `open_orders` read and the WS `open_orders` snapshot render.
///
/// Every field except `coin` is nullable here. A cancel or reject record
/// carries the coin and little else, so one shape decodes every lifecycle
/// record.
export interface WsOrderUpdateOrder {
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Side token, or `null` when unknown.
  side: TradeSide | null;
  /// Order price, whole-USDC decimal string, or `null`.
  px: string | null;
  /// REMAINING size after the commit (whole units), or `null`. On a `filled`
  /// record this is `orig_sz − filled_sz`; the filled amount itself rides the
  /// top-level `filled_sz`.
  sz: string | null;
  /// Original order size (whole units), or `null`.
  orig_sz: string | null;
  /// Order id, a decimal-digit STRING; `null` on a rejected placement.
  oid: string | null;
  /// Client order id (`0x`-hex), or `null`.
  cloid: string | null;
  /// Time-in-force token, or `null`.
  tif: OrderTif | null;
  /// Reduce-only flag, or `null`.
  reduce_only: boolean | null;
  /// Trigger detail, or `null`. A live delta never carries one.
  trigger: OrderTrigger | null;
  /// Insertion timestamp (consensus ms), or `null`. A live delta carries
  /// `null` here — read the event time from the record's `time` instead.
  inserted_at: number | null;
}

/// One `open_orders` channel record — the canonical order row. The channel
/// data is a BARE ARRAY of these rows, and every frame is a FULL snapshot.
export type WsOpenOrder = OpenOrder;

/// One `order_updates` channel record — per-account order lifecycle. Each
/// push is an array of records.
export interface WsOrderUpdate {
  /// The order's fixed-shape body.
  order: WsOrderUpdateOrder;
  /// Lifecycle state. `open` = resting (`order.sz` is the book remainder);
  /// `filled` = taker completion (cumulative `filled_sz` + `avg_px`; a maker
  /// leg reports per-match `filled_sz` with `status` still `open` while size
  /// rests); `rejected` carries `reason` + null `oid`.
  status: 'open' | 'filled' | 'canceled' | 'rejected' | 'cancel_rejected';
  /// Filled size (whole units decimal string), or `null`. On a MAKER record
  /// this is THIS match's size, not the cumulative filled amount.
  filled_sz: string | null;
  /// Average fill price (whole-USDC decimal string), or `null`.
  avg_px: string | null;
  /// Rejection reason, or `null`.
  reason: string | null;
  /// Record timestamp (consensus ms). On the on-subscribe snapshot the node
  /// copies it from the row's `inserted_at`, not the current block time.
  time: number;
}

/// One `user_fundings` channel record — a realized funding payment. Each push
/// is an array of records.
///
/// The amount key is `usdc`, matching the REST `user_funding` history record,
/// so a client can seed history from REST and merge live deltas.
export interface WsUserFunding {
  /// Market symbol the payment settled on (e.g. `"BTC"`).
  coin: string;
  /// Signed whole-USDC payment (`+` received / `−` paid), decimal string.
  usdc: string;
  /// Signed position size at settlement, whole units as a decimal string.
  szi: string;
  /// Per-hour rate applied at that settlement, decimal string.
  funding_rate: string;
  /// Settlement timestamp (consensus ms).
  time: number;
}

/// One `l2_book` / `bbo` price level.
///
/// The order-count key here is `n`. The REST `l2_book` read spells the same
/// count `n_orders` (see `L2Level`). The two are different keys — do not cast
/// one row type onto the other.
export interface WsL2Level {
  /// Level price, whole-USDC decimal string (tick-snapped).
  px: string;
  /// Summed size at the level, whole units as a decimal string.
  sz: string;
  /// Resting orders at the level.
  n: number;
}

/// `l2_book` channel payload — one market's aggregated depth.
///
/// `levels` is a two-element tuple: `levels[0]` is the bid side (best first,
/// descending price) and `levels[1]` the ask side (ascending). The REST
/// `l2_book` read instead returns flat `bids` / `asks` arrays.
export interface WsL2Book {
  /// Market symbol, or a spot pair name (`"BTC/USDC"`).
  coin: string;
  /// `[bids, asks]`.
  levels: [WsL2Level[], WsL2Level[]];
  /// Book timestamp (consensus ms).
  time: number;
}

/// `bbo` channel payload — top of each side.
///
/// `bbo` is a two-element tuple `[bid, ask]`; a side with no resting order is
/// `null`.
export interface WsBbo {
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Book timestamp (consensus ms).
  time: number;
  /// `[best bid, best ask]`.
  bbo: [WsL2Level | null, WsL2Level | null];
}

/// `candles` channel payload on the GATEWAY `/ws` mount. The bars fold a PRICE
/// series — the `mark` or `oracle` series the subscription's `candle_type`
/// selects — so they carry no volume and no trade count.
///
/// The envelope carries its OWN `snapshot` flag, separate from the frame-level
/// `WsFrame.is_snapshot`. The gateway always sends the frame flag as `false`
/// for this channel, so read `data.snapshot`, not the frame flag.
export interface WsCandleFrame {
  /// `true` = REPLACE the held history with `candles`; `false` = UPDATE or
  /// APPEND the single bar it carries.
  snapshot: boolean;
  /// Bars, oldest first. One bar on a delta tick, the full recent history on a
  /// snapshot. The bar is the REST `candle_snapshot` bar.
  candles: Candle[];
}

/// The `kind` tag on a `notifications` record.
export type WsNotificationKind =
  | 'yellow_card'
  | 'forced_close_tier'
  | 'tier_cleared'
  | 'forced_close'
  | 'backstop_residual'
  | 'backstop_residual_cleared'
  | 'mlp_backstop_takeover';

/// One `notifications` channel record — a per-account risk / liquidation
/// notice derived from a committed-state diff. Each push is an array.
///
/// `kind` tags the record. Only `kind`, `message` and `time` are on every
/// record; the rest depend on the kind.
export interface WsNotification {
  /// Record kind.
  kind: WsNotificationKind;
  /// Human-readable notice.
  message: string;
  /// Record timestamp (consensus ms).
  time: number;
  /// Liquidation tier the account entered; `null` on `tier_cleared`. Present on
  /// `yellow_card` / `forced_close_tier` / `tier_cleared`.
  tier?: string | null;
  /// Market symbol. Present on the per-market kinds.
  coin?: string;
  /// Position leg (`"long"` / `"short"`). Present on the per-leg kinds.
  side?: 'long' | 'short';
  /// Size closed by the forced close, whole units as a decimal string.
  closed_sz?: string;
  /// Un-fillable residual lots parked for the backstop executor.
  lots?: string;
  /// Signed size the backstop vault inherited (`mlp_backstop_takeover`).
  signed_sz?: string;
  /// Strike price of the takeover, whole-USDC decimal string.
  px?: string;
}

/// The `kind` tag on a `ledger_updates` record.
///
/// `deposit` (a bridge inbound credit) and `liquidation` (a forced-close
/// settlement) arrive in a later node release. They are listed here so a caller
/// can switch on them before that release ships.
///
/// The trailing `(string & {})` member is load-bearing: it keeps the literals
/// as editor completions while still ACCEPTING a kind this build has never
/// seen. The node adds kinds as it attributes more causes, and a closed union
/// would make every one of them a type error on arrival.
export type WsLedgerUpdateKind =
  | 'usd_send'
  | 'usd_receive'
  | 'spot_send'
  | 'spot_receive'
  | 'asset_send'
  | 'asset_receive'
  | 'withdraw'
  | 'deposit'
  | 'liquidation'
  | 'system_credit'
  | 'sub_account_transfer'
  | 'sub_account_spot_transfer'
  | 'vault_transfer'
  | (string & {});

/// One `ledger_updates` channel record — a per-account money movement drawn
/// from the committed block payload. Each push is an array; the on-subscribe
/// snapshot is the recent ring, NEWEST first.
///
/// `kind` tags the record. Only `kind`, `amount` and `time` are on every
/// record. `amount` is unsigned — read the direction from `kind` — except on a
/// `liquidation` record, where it is signed (negative on a loss). This differs
/// from the gateway `user_non_funding_ledger_updates` REST read, which
/// normalizes to a signed `delta`.
export interface WsLedgerUpdate {
  /// Record kind.
  kind: WsLedgerUpdateKind;
  /// Whole-token amount moved, decimal string. Unsigned.
  amount: string;
  /// Record timestamp (consensus ms).
  time: number;
  /// Token symbol. Absent on the USD-plane kinds (`usd_send` / `usd_receive`).
  coin?: string;
  /// Recipient 0x address on a send.
  destination?: string;
  /// Sender 0x address on a receive.
  from?: string;
  /// Destination EVM chain id (`withdraw` via the `Withdraw3` action).
  destination_chain_id?: number;
  /// Destination chain label (`withdraw` via the MetaBridge action).
  chain?: string;
  /// Withdraw lane label, e.g. `"metabridge"`.
  via?: string;
  /// Sub-account index (the `sub_account_*` kinds).
  sub_index?: number;
  /// Vault id (`vault_transfer`).
  vault_id?: number;
  /// `true` = funds move INTO the sub-account / vault. Present on the
  /// `sub_account_*` and `vault_transfer` kinds.
  deposit?: boolean;
  /// `true` = the asset moves to the perp side (`asset_send` / `asset_receive`).
  to_perp?: boolean;
  /// Perp market a `liquidation` record's forced close ran on. Not live yet.
  market?: string;
  /// Forced-close cause on a `liquidation` record, e.g. `"forced_close_full"`.
  /// Not live yet.
  cause?: string;
  /// Whole-USDC mark a `liquidation` slice was priced from; absent when the
  /// market had no usable mark. On a `liquidation` record `amount` is SIGNED
  /// (negative on a loss) — the one signed exception on this channel. Not
  /// live yet.
  mark_px?: string;
}

/// One `user_twap_slice_fills` channel record — a TWAP child slice that filled.
///
/// `twapId` is camelCase on the wire. That spelling is the server contract for
/// the two TWAP channels, not a defect; keep it.
export interface WsTwapSliceFill {
  /// The slice's fill leg, in the same record shape the `fills` channel pushes.
  fill: WsFill;
  /// Parent TWAP id.
  twapId: number;
}

/// The `state` block inside a `WsTwapHistoryRecord`. The keys `executedSz` and
/// `reduceOnly` are camelCase on the wire — the server contract for the TWAP
/// channels.
export interface WsTwapHistoryState {
  /// Parent TWAP id — the id `twap_cancel` needs.
  twapId: number;
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Total parent size, whole units as a decimal string.
  sz: string;
  /// Size executed so far, whole units as a decimal string.
  executedSz: string;
  /// Parent duration in minutes.
  minutes: number;
  /// Whether the parent may only reduce an existing position.
  reduceOnly: boolean;
  /// Transition timestamp (consensus ms).
  timestamp: number;
}

/// One `user_twap_history` channel record — a TWAP parent lifecycle
/// transition. Each push is an array.
export interface WsTwapHistoryRecord {
  /// Transition timestamp (consensus ms).
  time: number;
  /// The parent's state at the transition.
  state: WsTwapHistoryState;
  /// The new status, wrapped one level deep.
  status: {
    /// Status token, e.g. `"activated"` / `"finished"` / `"terminated"`.
    status: string;
  };
}

/// One `markets` channel row — a market's DYNAMIC state. Each push is an array;
/// the on-subscribe frame holds every market, later frames hold only the rows
/// that MOVED.
///
/// `kind` splits the row: a `"spot"` row carries only `coin` / `kind` /
/// `mark_px` / `mid_px` / `day_ntl_vlm` / `prev_day_px`, because the remaining
/// fields have no spot analogue.
///
/// This is NOT the REST `markets` read, which returns `{perp, spot}` of STATIC
/// market definitions.
export interface WsMarketRow {
  /// Market symbol, or the pair name on a spot row.
  coin: string;
  /// Row class.
  kind: MarketKind;
  /// Mark price, whole-USDC decimal string (tick-snapped). `null` on a spot row
  /// that has no USDC-quoted pair or no trade yet — the key is always present.
  mark_px: string | null;
  /// Real book mid, tick-snapped. Omitted when the book is one-sided.
  mid_px?: string;
  /// Rolling 24h notional volume, decimal string.
  day_ntl_vlm: string;
  /// Mark price 24h ago; `null` when no 24h reference exists.
  prev_day_px: string | null;
  /// Latest committed oracle price, tick-snapped. Perp rows only.
  oracle_px?: string;
  /// Present and `true` only when the oracle index is stale. Perp rows only.
  px_stale?: boolean;
  /// Depth-aware impact prices `[bid, ask]`, whole-USDC decimal strings.
  /// Omitted when either side is too thin. Perp rows only.
  impact_pxs?: [string, string];
  /// Latest funding premium sample; `null` when none. Perp rows only.
  premium?: string | null;
  /// Funding parameters. Perp rows only.
  funding?: Funding;
  /// True position open interest, whole units. Perp rows only.
  open_interest?: string;
  /// 24h price change as a decimal fraction; `null` when no reference exists.
  /// Perp rows only.
  change_24h?: string | null;
  /// Whether the market is halted. Perp rows only.
  halted?: boolean;
}

/// `account_state` channel payload — the SAME body the REST `account_state`
/// read returns, including the `height` / `time` stamp.
export type WsAccountState = AccountState;

/// `clearinghouse_state` channel payload — the SAME body the REST
/// `clearinghouse_state` read returns, including the `height` / `time` stamp.
///
/// Position rows NEVER carry `adl_lamps` here. The lamp ranks one account
/// against the others in the market, so an always-on lamp would re-emit this
/// account whenever a STRANGER's return-on-equity crossed a quartile. Ask the
/// REST read with `detail: "adl"` for the column.
export type WsClearinghouseState = ClearinghouseState;

/// `option_state` channel payload — the SAME body the REST `option_state` read
/// returns, including the `height` / `time` stamp.
export type WsOptionState = OptionState;

/// `spot_margin_state` channel payload — the REST `spot_margin_state` body PLUS
/// the `height` / `time` stamp. The REST read carries no stamp.
export type WsSpotMarginState = SpotMarginState & {
  /// Committed block height of the snapshot.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
};

/// Body type per channel — the shape of `WsFrame.data` for each channel name.
///
/// Use it with `isChannelFrame` to narrow an inbound frame. Channels whose
/// frames are arrays are typed as arrays here.
export interface WsChannelData {
  l2_book: WsL2Book;
  bbo: WsBbo;
  trades: WsTrade[];
  markets: WsMarketRow[];
  /// Served by the GATEWAY only. The node does not aggregate OHLCV, so a
  /// node-direct subscribe is refused as an unknown channel.
  candles: WsCandleFrame;
  fills: WsFill[];
  order_updates: WsOrderUpdate[];
  open_orders: WsOpenOrder[];
  notifications: WsNotification[];
  ledger_updates: WsLedgerUpdate[];
  user_fundings: WsUserFunding[];
  user_twap_slice_fills: WsTwapSliceFill[];
  user_twap_history: WsTwapHistoryRecord[];
  account_state: WsAccountState;
  clearinghouse_state: WsClearinghouseState;
  option_state: WsOptionState;
  spot_margin_state: WsSpotMarginState;
  active_asset_data: ActiveAssetDataFrame;
}

/// A typed inbound frame `{channel, data}`. `data` stays `unknown` because one
/// handler receives every channel; narrow it with `isChannelFrame`.
/// `subscriptionResponse`, `error` and `pong` are the control frames.
export interface WsFrame {
  channel: string;
  data: unknown;
  /// `true` marks an on-subscribe FULL snapshot; `false` (or absent) marks a
  /// post-subscribe delta. Absent reads as a delta, so an older node that does
  /// not send the flag never makes a delta look like a snapshot.
  ///
  /// The `candles` channel is the exception: read `data.snapshot` there.
  is_snapshot?: boolean;
}

/// A frame already narrowed to one channel, with `data` typed as that channel's
/// body.
export type WsChannelFrame<C extends WsChannel> = WsFrame & {
  channel: C;
  data: WsChannelData[C];
};

/// Narrow an inbound frame to one channel and its body type.
///
/// ```ts
/// ws.onMessage((f) => {
///   if (isChannelFrame(f, 'user_fundings')) {
///     for (const r of f.data) console.log(r.coin, r.usdc);
///   }
/// });
/// ```
///
/// This is a NAME check only. It trusts the server to send the documented body
/// for the channel it labels; it does not validate the body.
export function isChannelFrame<C extends WsChannel>(
  frame: WsFrame,
  channel: C,
): frame is WsChannelFrame<C> {
  return frame.channel === channel;
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
/// distinct subscriptions). The `l2_book` aggregation params are appended so a
/// param change is a distinct local key; the server, however, holds ONE
/// `l2_book` view per coin (params are NOT part of ITS routing key), so
/// `subscribe`/`unsubscribe` also dedupe `l2_book` by coin — see there.
function subKey(s: WsSubscription): string {
  return (
    `${s.type}:${s.coin ?? ''}:${s.user ?? ''}:${s.interval ?? ''}` +
    `:${s.candle_type ?? ''}` +
    `:${s.n_sig_figs ?? ''}:${s.mantissa ?? ''}:${s.n_levels ?? ''}`
  );
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
  /// Sticky: offer no subprotocol on every later attempt. Set when a socket
  /// that offered one closed before it opened.
  private plainHandshake = false;
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
  ///
  /// `l2_book` is special: the server holds exactly ONE view per coin and
  /// REPLACES it (with the new aggregation params) on a re-subscribe. So we
  /// first drop any active `l2_book` entry for the same coin — otherwise a
  /// stale-params entry would be replayed on reconnect and clobber the view.
  async subscribe(sub: WsSubscription): Promise<void> {
    if (sub.type === 'l2_book') {
      for (const [k, s] of this.active) {
        if (s.type === 'l2_book' && s.coin === sub.coin) this.active.delete(k);
      }
    }
    const key = subKey(sub);
    if (!this.active.has(key)) {
      this.active.set(key, sub);
    }
    this.send({ method: 'subscribe', subscription: sub });
  }

  /// Unsubscribe from a channel. For `l2_book` the server's unsubscribe is
  /// keyed by coin alone (params-blind), so any active `l2_book` entry for the
  /// coin is dropped regardless of its aggregation params.
  async unsubscribe(sub: WsSubscription): Promise<void> {
    if (sub.type === 'l2_book') {
      for (const [k, s] of this.active) {
        if (s.type === 'l2_book' && s.coin === sub.coin) this.active.delete(k);
      }
    } else {
      this.active.delete(subKey(sub));
    }
    this.send({ method: 'unsubscribe', subscription: sub });
  }

  // ── convenience subscribe helpers ─────────────────────────────────────────
  //
  // `coin` is the market SYMBOL string (e.g. `"BTC"`) — the canonical key on
  // the consolidated surface. A decimal asset-id string is also accepted.

  /// Subscribe to L2 book updates for a market. `coin` is a perp symbol
  /// (`"BTC"`) or a spot pair NAME (`"BTC/USDC"`) / pair id; spot pairs now
  /// carry real depth. Optional `params` request HL-style depth grouping — the
  /// camelCase fields are mapped to the wire-verbatim snake_case
  /// `n_sig_figs`/`mantissa`/`n_levels`, each included ONLY when defined. The
  /// server holds one book view per coin and REPLACES it on a re-subscribe with
  /// new params. The ack echoes the params (`mantissa` only when ≠ 1).
  async subscribeL2Book(coin: string, params?: L2BookParams): Promise<void> {
    const sub: WsSubscription = { type: 'l2_book', coin };
    if (params?.nSigFigs !== undefined) sub.n_sig_figs = params.nSigFigs;
    if (params?.mantissa !== undefined) sub.mantissa = params.mantissa;
    if (params?.nLevels !== undefined) sub.n_levels = params.nLevels;
    return this.subscribe(sub);
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

  /// Subscribe to price bars for a market + interval token. `candleType` picks
  /// the series and defaults to `mark`; it is sent ONLY when provided.
  async subscribeCandles(
    coin: string,
    interval: string,
    candleType?: CandleType,
  ): Promise<void> {
    const sub: WsSubscription = { type: 'candles', coin, interval };
    if (candleType !== undefined) sub.candle_type = candleType;
    return this.subscribe(sub);
  }

  /// Subscribe to the global market-universe stream (`markets`). No params.
  ///
  /// Every row carries mid, mark, oracle, funding and open interest, so this
  /// ONE subscription answers what the retired `all_mids` and
  /// `active_asset_ctx` channels each answered in part.
  async subscribeMarkets(): Promise<void> {
    return this.subscribe({ type: 'markets' });
  }

  /// Subscribe to per-user fills (0x address).
  async subscribeFills(user: string): Promise<void> {
    return this.subscribe({ type: 'fills', user });
  }

  /// Subscribe to per-user order lifecycle updates (0x address).
  async subscribeOrderUpdates(user: string): Promise<void> {
    return this.subscribe({ type: 'order_updates', user });
  }

  /// Subscribe to the per-user resting-order snapshot stream (`open_orders`,
  /// 0x address). Carries the account's open perp AND spot orders.
  async subscribeOpenOrders(user: string): Promise<void> {
    return this.subscribe({ type: 'open_orders', user });
  }

  /// Subscribe to per-user money movement (deposit / withdraw / transfer).
  async subscribeLedgerUpdates(user: string): Promise<void> {
    return this.subscribe({ type: 'ledger_updates', user });
  }

  /// Subscribe to per-user realized funding payments (0x address).
  async subscribeUserFundings(user: string): Promise<void> {
    return this.subscribe({ type: 'user_fundings', user });
  }

  /// Subscribe to the per-user live account-state stream (0x address). The
  /// frame carries the DEFAULT depth: the account scalars and the four lane
  /// summaries. The perp POSITION rows ride the `clearinghouse_state` channel
  /// instead. With the REST `detail: "overview"` read, this covers the whole
  /// account.
  async subscribeAccountState(user: string): Promise<void> {
    return this.subscribe({ type: 'account_state', user });
  }

  /// Subscribe to the per-user PERP POSITION stream (0x address). Each frame
  /// is the same body the REST `clearinghouse_state` read returns.
  ///
  /// This is the position detail that left `account_state`. Subscribe to BOTH
  /// channels for the whole picture, and compare `height` before you read a
  /// summary and a detail together.
  async subscribeClearinghouseState(user: string): Promise<void> {
    return this.subscribe({ type: 'clearinghouse_state', user });
  }

  /// Subscribe to the per-user option-leg stream (0x address). Each frame is
  /// the same body the REST `option_state` read returns.
  async subscribeOptionState(user: string): Promise<void> {
    return this.subscribe({ type: 'option_state', user });
  }

  /// Subscribe to the per-user spot-margin position stream (0x address). Each
  /// frame is the same body the REST `spot_margin_state` read returns.
  async subscribeSpotMarginState(user: string): Promise<void> {
    return this.subscribe({ type: 'spot_margin_state', user });
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
  // — signed with the SAME typed EIP-712 digest the REST `/exchange` path uses.
  // The node reconstructs the typed struct from the parsed `action` fields (NOT
  // the raw bytes), so re-embedding the action as `JSON.parse(actionJson)` is
  // safe. Correlated by `id`; a `{type:"error"}` response surfaces as an error;
  // each request has a timeout. The opaque `MetaFluxAction(string action,uint64
  // nonce)` scheme is GONE — the node is typed-only.

  /// Issue a signed typed account action over the WS `post` channel, returning
  /// the node's action response payload. `actionType` is a typed-scheme tag (the
  /// same set `Client.submitTyped` accepts, e.g. `set_position_mode`); `payload`
  /// carries the action-specific snake_case fields. Requires a `WsSigner` (passed
  /// to the constructor, or via `Client.connectWs` with a keyed client). Pass
  /// `opts.owner` for an owner-supporting action to bind an agent-resolved owner.
  async postAction(
    actionType: string,
    payload: Record<string, unknown>,
    opts: { nonce?: bigint; owner?: string } = {},
  ): Promise<unknown> {
    if (this.signer === undefined) {
      throw new Error(
        'postAction requires a WsSigner (this WsClient was opened read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const signed = await signTypedAction(
      this.signer.privateKey,
      actionType,
      payload,
      nonce,
      this.signer.chainId,
      opts.owner,
    );
    const body = {
      signature: signed.signature,
      nonce: Number(signed.nonce),
      action: JSON.parse(signed.actionJson) as unknown,
    };
    return this.postRequest('action', body);
  }

  /// Issue an `info` read over the WS `post` channel, returning the info response
  /// payload. `payload` is the usual `{"type":"<info>",...}` body. No signing.
  async postInfo(payload: { type: string; [k: string]: unknown }): Promise<unknown> {
    return this.postRequest('info', payload);
  }

  /// Submit a limit / market / trigger order over the WS `post` channel under
  /// the typed scheme.
  ///
  /// `order.owner` is the ACCOUNT the order belongs to, which is not always the
  /// signer: set it to the signing wallet for self-trading, or to the VAULT
  /// address for operator-driven vault trading. The chain admits the account
  /// itself, an approved agent, and a registered metaliquidity operator — the
  /// operator is written into the vault's own `approved_agents` — so this lane
  /// does NOT require owner == signer. A `WsClient` has no `/info` reader, so it
  /// cannot check the delegation the way `Client.assertMayActFor` does; the node
  /// is the authority and rejects a signer that may not act.
  async submitOrder(order: NativeOrder): Promise<NativeExchangeAck> {
    if (this.signer === undefined) {
      throw new Error('submitOrder requires a WsSigner (read-only WsClient)');
    }
    const actionJson = buildNativeOrderAction(order);
    return (await this.postTypedTrade(
      'submit_order',
      { order },
      actionJson,
    )) as NativeExchangeAck;
  }

  /// Cancel an order over the WS `post` channel under the typed scheme.
  /// `cancel.owner` follows `submitOrder`: it is the account that owns the
  /// resting order and may differ from the signer.
  /// The typed digest binds `oid`, so a cloid-only cancel throws (no typed form).
  async cancelOrder(cancel: NativeCancel): Promise<NativeExchangeAck> {
    if (this.signer === undefined) {
      throw new Error('cancelOrder requires a WsSigner (read-only WsClient)');
    }
    const actionJson = buildNativeCancelAction(cancel);
    return (await this.postTypedTrade(
      'cancel_order',
      { cancel },
      actionJson,
    )) as NativeExchangeAck;
  }

  /// Sign a trading action under the typed scheme and post it over the WS `post`
  /// channel. Signs the SAME typed digest the REST `postTypedOrder` path uses
  /// (`../native/typed_orders.ts`); the node re-derives the digest from the
  /// parsed `action` fields. Mirrors the proven Rust WS `post_typed_trade`
  /// payload shape `{signature, nonce, action}`.
  private async postTypedTrade(
    actionType: string,
    payload: TypedOrderPayload,
    actionJson: string,
  ): Promise<unknown> {
    const nonce = nextNonce();
    const signed = await signTypedOrder(
      this.signer!.privateKey,
      actionType,
      payload,
      actionJson,
      nonce,
      this.signer!.chainId,
    );
    const body = {
      signature: signed.signature,
      nonce: Number(signed.nonce),
      action: JSON.parse(signed.actionJson) as unknown,
    };
    return this.postRequest('action', body);
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
      let opened = false;
      // Per socket, not per client: a reconnect can select another mode.
      let zstd = false;
      const offered = !this.plainHandshake;
      const sock = new WebSocket(this.url, offered ? [ZSTD_PROTOCOL] : []);
      sock.binaryType = 'arraybuffer';
      this.socket = sock;

      sock.onopen = () => {
        opened = true;
        zstd = sock.protocol === ZSTD_PROTOCOL;
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
        if (typeof ev.data === 'string') {
          this.dispatch(ev.data);
          return;
        }
        if (!zstd) return; // Binary in text mode: not ours, drop it.
        try {
          const raw = decompress(new Uint8Array(ev.data as ArrayBuffer));
          this.dispatch(UTF8.decode(raw));
        } catch {
          // Every frame is an independent zstd frame, so one bad frame
          // poisons nothing. Drop it, like any other malformed frame.
        }
      };

      sock.onerror = () => {
        // With a token offered, the retry in `onclose` owns the outcome.
        if (!settled && !offered) {
          settled = true;
          reject(new Error(`WsClient failed to connect to ${this.url}`));
        }
        // Post-open errors are handled by onclose → reconnect.
      };

      sock.onclose = () => {
        this.clearTimers();
        this.socket = undefined;
        if (!opened && offered && !this.closed) {
          this.plainHandshake = true;
          this.openOnce().then(resolve, reject);
          return;
        }
        if (!settled) {
          settled = true;
          reject(new Error(`WsClient failed to connect to ${this.url}`));
        }
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
      if (typeof parsed.is_snapshot === 'boolean') {
        frame.is_snapshot = parsed.is_snapshot;
      }
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
