// Book / trade / account-history response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md. Field
// names are the exact snake_case keys the node emits inside `{type, data}.data`.
// Money magnitudes that can exceed 2^53 are typed `string`.
//
// KEYING (consolidated surface): market-scoped reads take `coin` (the market
// SYMBOL, e.g. `"BTC"`); account-scoped reads take `address` (0x hex). The
// numeric `market_id` / `asset_id` / `account_id` request params are gone.

/// The canonical side token: `"B"` = buy/bid, `"A"` = sell/ask. One token set
/// for every kind that carries a side — trades, fills, orders, and book reads.
export type TradeSide = 'B' | 'A';

/// Time-in-force token on an order row. `"trigger"` is not a real TIF: it
/// labels a PARKED TP / SL / stop row, whose detail rides `OpenOrder.trigger`.
export type OrderTif = 'alo' | 'ioc' | 'gtc' | 'trigger';

/// The trigger block on an order row.
///
/// A resting book order with an attached trigger carries `trigger_px` +
/// `trigger_above` only. A PARKED (off-book) TP / SL / stop row also carries
/// `is_parked` + `is_market` + `limit_px`.
///
/// `group` and `trail_px` are absent again on all of those. The node writes
/// each key only on the leg that owns it, so a row that owns neither is
/// byte-identical to the row this type described before the keys existed.
export interface OrderTrigger {
  /// Trigger price, canonical decimal string (whole-USDC, tick-snapped).
  trigger_px: string;
  /// Whether the trigger fires above (`true`) or below the price.
  trigger_above: boolean;
  /// `true` on a parked (off-book) TP / SL / stop row. Absent on the trigger
  /// block of a resting book order.
  is_parked?: boolean;
  /// `true` = MARKET trigger (`limit_px` is `null`); `false` = LIMIT trigger.
  /// Parked rows only.
  is_market?: boolean;
  /// Limit price of a parked LIMIT trigger, decimal string; `null` on a market
  /// trigger.
  limit_px?: string | null;
  /// Scaled-TP/SL LADDER handle, shared by every leg of one ladder.
  ///
  /// A `positionTpsl` batch of THREE or more protective legs parks a ladder.
  /// Its legs share this handle, and they are NOT OCO: a fill of one leg does
  /// not cancel the others. One or two legs are the older shapes — a lone
  /// trigger, or an OCO pair — and omit the key. Group rows by this value to
  /// render one ladder; the whole ladder retires together when the position it
  /// protects closes.
  group?: number;
  /// TRAILING callback, an absolute price offset as a decimal string.
  ///
  /// Present means the parked level ratchets toward the mark by this offset and
  /// never away from it. Read `trigger_px` as the RATCHETED level, NOT the
  /// level the owner sent. Absent means a static level.
  ///
  /// READ ONLY today. No type in this SDK can send it — see `NativeTrigger`.
  trail_px?: string;
}

/// One resting order inside an `OpenOrders` response.
///
/// This is the ONE canonical order row. The REST `open_orders` read, the WS
/// `open_orders` snapshot, and the inner `order` of a WS `order_updates`
/// record all render it, so the three surfaces cannot drift.
///
/// `px` / `sz` are CANONICAL decimal strings (positive price for **both**
/// sides, tick-snapped whole-USDC; size in whole units) — no client-side
/// rescaling is needed.
///
/// Spot resting orders appear here alongside perp orders — a spot row's `coin`
/// is the pair NAME (e.g. `"BTC/USDC"`), with `px` / `sz` in that pair's
/// planes. Parked TP / SL / stop triggers are in the row set too: they carry
/// `tif: "trigger"` and a populated `trigger` block.
export interface OpenOrder {
  /// Server order id, a decimal-digit STRING.
  oid: string;
  /// Market symbol the order rests on — a perp symbol (`"BTC"`) or a spot pair
  /// name (`"BTC/USDC"`).
  coin: string;
  /// Order side token.
  side: TradeSide;
  /// Resting price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Remaining size, canonical decimal string (whole units).
  sz: string;
  /// Original order size, decimal string. `null` on a snapshot row — the
  /// committed book does not retain it.
  orig_sz: string | null;
  /// Client order id (`0x`-hex), or `null` when the order carried none.
  cloid: string | null;
  /// Time-in-force token, or `null` when unknown.
  tif: OrderTif | null;
  /// Whether the order is reduce-only, or `null` when unknown.
  reduce_only: boolean | null;
  /// Trigger detail when the order has one, else `null`.
  trigger: OrderTrigger | null;
  /// Insertion timestamp (consensus ms).
  inserted_at: number;
}

/// `open_orders` — account-scoped resting orders across every perp AND spot
/// book, plus parked triggers. Spot rows carry the pair NAME as `coin`
/// (e.g. `"BTC/USDC"`).
export interface OpenOrders {
  /// Resolved account address (0x).
  address: string;
  /// Resting orders.
  orders: OpenOrder[];
}

/// Optional HL-style depth-aggregation params for an `l2_book` query (REST +
/// WS). All optional; omit for the ungrouped (finest) book. The gateway groups
/// deterministically AWAY from the spread and sums sizes, then caps to
/// `nLevels` levels per side.
export interface L2BookParams {
  /// Significant figures to round each price to for grouping — 2..=5. Coarser
  /// (fewer figs) = fewer, wider levels.
  nSigFigs?: number;
  /// Sub-figure mantissa bucket — `1` | `2` | `5`. Only valid together with
  /// `nSigFigs === 5`; the gateway rejects it otherwise.
  mantissa?: number;
  /// Max levels returned per side (≥ 1). The load-reduction lever.
  nLevels?: number;
}

/// One aggregated L2 book level.
export interface L2Level {
  /// Level price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Summed size at the level, canonical decimal string (whole units).
  sz: string;
  /// Resting orders at the level.
  n_orders: number;
}

/// `l2_book` — market-scoped aggregated bid/ask levels, keyed by `coin`.
///
/// `coin` may be a perp symbol (`"BTC"`) or a spot pair — its NAME
/// (`"BTC/USDC"`) or numeric pair id — and spot pairs now render real depth.
/// The optional `L2BookParams` group the book HL-style away from the spread.
export interface L2Book {
  /// Echoed market symbol / pair.
  coin: string;
  /// Bid side (best-first, descending price).
  bids: L2Level[];
  /// Ask side (ascending price).
  asks: L2Level[];
}

/// One public trade record on the `trades` read (ranged or not; the
/// WS `trades` channel adds `users`).
export interface TradeRecord {
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
  /// its low digits here. Compare it as a string, or convert with `BigInt`.
  tid: string;
  /// Committed block height the trade landed in.
  block: number;
  /// Transaction hash of the originating taker action (`0x`-hex).
  ///
  /// ABSENT = not recorded: an archive-served print, whose table stores no
  /// trace hash. `""` = recorded, and there was no signed taker action (a
  /// system fill). The two are different facts.
  hash?: string;
}

/// `trades` — market-scoped public trade tape, keyed by `coin`.
///
/// One read, two asks. An UN-RANGED ask returns the recent ring, newest first,
/// and always answers from the node. A RANGED ask (one that carries
/// `start_time` or `end_time`) filters on each record's consensus `time` and
/// reaches the gateway archive, oldest first.
///
/// An archive-served print OMITS `hash` rather than sending `""`: absent is
/// "not recorded", `""` is "recorded, and there was no signed taker action".
export interface Trades {
  /// Echoed market symbol.
  coin: string;
  /// Timestamp of the newest trade in this answer (consensus ms; `0` if none).
  last_trade: number;
  /// Echoed window start (ms), `null` when the request omitted it.
  start_time: number | null;
  /// Echoed window end (ms), `null` when the request omitted it.
  end_time: number | null;
  /// The trades.
  trades: TradeRecord[];
}

/// One fill inside a `UserFills` history. Also the `filled` branch of an
/// `OrderStatusInfo`.
export interface UserFill {
  /// Market the fill executed on — the coin SYMBOL. A perp symbol (`"MTF"`) or
  /// a spot pair NAME (`"MTF/USDC"`). The node fill serializer renders the
  /// symbol, matching the trade tape (not a numeric id).
  coin: string;
  /// This leg's side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Execution price, 8-dp tape decimal string (trailing zeros kept).
  px: string;
  /// Filled size, decimal string. PERP: human plane (`sz_decimals` fraction
  /// digits) in every chain state.
  ///
  /// SPOT depends on the chain's `spot_tape_size_plane` feature, so do not
  /// assume either state. Active — the default on a chain started from a fresh
  /// genesis — renders spot size on the pair's BASE-token `sz_decimals`, the
  /// same human plane every other read serves. Inactive, which is where an
  /// older chain sits until an `ArmFeatures` vote arms it, renders the raw lot
  /// integer with no fraction part. Parse it as a decimal string either way and
  /// take the plane from the pair's metadata, never from the digits.
  sz: string;
  /// Fill timestamp (consensus ms).
  time: number;
  /// This party's order id, a decimal-digit STRING.
  oid: string;
  /// Deterministic trade id (shared by both legs of the print), a
  /// decimal-digit STRING — it exceeds `Number.MAX_SAFE_INTEGER`, so a JSON
  /// number would lose its low digits. Compare it as a string, or use `BigInt`.
  tid: string;
  /// Fee this party paid, decimal string. See `fee_token` for the denomination.
  fee: string;
  /// Coin symbol the `fee` is denominated in.
  ///
  /// Read this before summing `fee`. A perp fee is always `"USDC"`. A spot SELL
  /// charges USDC, but a spot BUY charges the BASE token — a BTC/USDC buy pays
  /// its fee in BTC. Summing `fee` without this field adds BTC to USDC.
  fee_token?: string;
  /// Realized PnL on the closed portion, whole-USDC (signed) decimal string.
  closed_pnl: string;
  /// Direction label, e.g. `"Open Long"` / `"Close Short"`.
  dir: string;
  /// Signed leg size BEFORE the fill, same size plane as `sz` (signed).
  start_position: string;
  /// Committed block height the fill settled in. The node ring always carries
  /// it; a gateway archive-normalized fill may omit it.
  block?: number;
  /// Transaction hash of the originating order (`0x`-hex); empty string when
  /// there is no signed taker action (maker legs / system fills).
  hash: string;
  /// Why this leg executed when the party did NOT cross by its own order:
  /// `'forced_close_partial'` / `'forced_close_full'` (the liquidation ladder),
  /// `'forced_close_isolated'`, `'trigger'`, or `'twap'`.
  ///
  /// Absent on an ordinary fill and on EVERY maker leg — a counterparty that
  /// was merely hit is not itself forced.
  cause?: string;
  /// The account whose position was closed. Present on a forced-close leg, on
  /// BOTH sides of the print, so a taker can see whose liquidation it took on.
  liquidated_user?: string;
  /// The mark the liquidation ladder priced from when it classified — NOT the
  /// fill price. Present with `liquidated_user`.
  mark_px?: string;
  /// The broker that routed the order. Taker leg only.
  broker?: string;
  /// The broker carve charged on this fill, whole-USDC decimal string. `'0'` is
  /// legal — a zero-rate broker is still attributed.
  broker_fee?: string;
  /// The parent TWAP this slice belongs to. Present when `cause` is `'twap'`.
  twap_id?: number;
}

/// `user_fills` — account-scoped fill history, keyed by `address`.
///
/// One read, two asks. An UN-RANGED ask returns the recent ring, newest first
/// (the gateway merges deep archive history when available). A RANGED ask
/// filters on each record's consensus `time` and returns oldest first.
export interface UserFills {
  /// Resolved account address (0x).
  address: string;
  /// Echoed window start (ms), `null` when the request omitted it.
  start_time: number | null;
  /// Echoed window end (ms), `null` when the request omitted it.
  end_time: number | null;
  /// Fills.
  fills: UserFill[];
}

/// One CLOSED position lifecycle inside a `UserPositionHistory`.
///
/// A position that is still OPEN is never in this history — read the live
/// position from the `clearinghouse_state` read. The archive emits a row
/// only once the lifecycle closes.
///
/// DERIVED, never stored: `realized_pnl = closed_pnl − fee_paid` and
/// `net_pnl = realized_pnl + funding_paid`. `closed_pnl` is the chain's own
/// lot-matched number — it is NOT `(avg_close_px − avg_entry_px) × closed_sz`
/// and must not be checked that way.
///
/// THE THREE COMPLETENESS FLAGS ARE THE HONESTY MECHANISM. The archive can be
/// cut by a recorded gap or by the retention floor, and a cut row still has to
/// be served. Each flag says whether that side of the life is whole:
///   * `entry_complete: false` ⇒ the open side is partial, and `max_sz` /
///     `avg_entry_px` come back `null` rather than wrong.
///   * `close_complete: false` ⇒ every close-side number covers part of the
///     life. It follows `entry_complete`: the cut that hid the open can hide a
///     close too.
///   * `funding_complete: false` ⇒ `funding_paid` is UNKNOWN, not zero. The row
///     still reads `"0"`, and `net_pnl` then equals `realized_pnl` and excludes
///     funding.
///
/// Test the flag before trusting the number. A degraded row is served on
/// purpose, not by mistake.
export interface PositionHistoryRow {
  /// Market symbol (`"BTC"`) or spot pair name. The gateway resolves the
  /// archive's numeric market id to this symbol.
  coin: string;
  /// Position direction over the life.
  side: 'long' | 'short';
  /// Largest size the position ever held, decimal string on the size plane.
  /// `null` exactly when `entry_complete` is `false`.
  max_sz: string | null;
  /// Size closed over the life, decimal string on the size plane.
  closed_sz: string;
  /// Weighted average entry price, whole-USDC decimal string. `null` exactly
  /// when `entry_complete` is `false`.
  avg_entry_px: string | null;
  /// Weighted average close price, whole-USDC decimal string; `null` when the
  /// archive holds no priced close side.
  avg_close_px: string | null;
  /// Lot-matched realized PnL before fees, whole-USDC decimal string.
  closed_pnl: string;
  /// Fees paid over the life, whole-USDC decimal string.
  fee_paid: string;
  /// `closed_pnl − fee_paid`, whole-USDC decimal string.
  realized_pnl: string;
  /// Funding paid over the life, whole-USDC decimal string. `"0"` with
  /// `funding_complete: false` means UNKNOWN, not "no funding was paid".
  funding_paid: string;
  /// `realized_pnl + funding_paid`, whole-USDC decimal string.
  net_pnl: string;
  /// Consensus ms the position opened.
  opened_at: number;
  /// Consensus ms the position closed.
  closed_at: number;
  /// Committed height the position opened at.
  open_block: number;
  /// Committed height the position closed at.
  close_block: number;
  /// Whether the open side covers the whole life.
  entry_complete: boolean;
  /// Whether the close side covers the whole life.
  close_complete: boolean;
  /// Whether `funding_paid` covers the whole life.
  funding_complete: boolean;
}

/// `user_position_history` / `user_position_history_by_time` — one row per
/// CLOSED position lifecycle, keyed by `address`.
///
/// The envelope is the SAME shape `user_fills` uses: the echoed address and the
/// rows, nothing else. Neither variant echoes the request window (unlike
/// `UserFillsByTime`), and neither carries an account-wide coverage or
/// completeness object — the per-row flags on `PositionHistoryRow` are the only
/// completeness report.
///
/// `user_position_history` pages newest-first. `_by_time` reads oldest-first
/// inside an inclusive `[start_time, end_time]` window over `closed_at`; a
/// lifecycle is a point event at its close, so a position OPENED before the
/// window but CLOSED inside it IS returned.
export interface UserPositionHistory {
  /// Resolved account address (0x).
  address: string;
  /// Closed position lifecycles.
  positions: PositionHistoryRow[];
}

/// One funding sample inside a `FundingHistory`.
export interface FundingSample {
  /// Sample timestamp (consensus ms).
  ts: number;
  /// Raw funding premium sample (signed, pre-clamp), decimal string.
  premium: string;
  /// The clamped rate that settlement actually charges (premium passed
  /// through the per-market per-hour cap), decimal string.
  funding_rate: string;
}

/// `funding_history` — market-scoped funding premium samples, keyed by `coin`.
export interface FundingHistory {
  /// Echoed market symbol.
  coin: string;
  /// Ordered ring of samples.
  samples: FundingSample[];
}

/// The price series a candle folds — the `candle_type` request field.
///
/// `"mark"` is the DEFAULT and serves perp and spot markets. `"oracle"` serves
/// perp markets only; a spot pair always answers empty. The executed-trade
/// candle is RETIRED: `"trade"` is rejected like any other unknown token, never
/// served as the other series.
/// The candle series selector.
///
/// A PRICE series (`mark`, `oracle`) has a bar in every window its samples
/// cover. The `trade` series is SPARSE: a window with no fill has NO bar, never
/// a carried-forward one — do not gap-fill it.
///
/// `v` and `n` also differ. A price bar reports `v` as `"0"` and `n` as a
/// SAMPLE count; a trade bar reports real volume and a real trade count.
export type CandleType = 'mark' | 'oracle' | 'trade';

/// One bar from the `candle_snapshot` read.
///
/// Compact keys: `t`/`T` bar open/close epoch-ms, `s` symbol, `i` interval
/// token, `o`/`c`/`h`/`l` whole-USDC decimal strings, `f` the filled-bar flag,
/// and the OPTIONAL `v`/`q`/`n` volume triple.
///
/// The bar folds a SAMPLED price series, not the continuous price path.
/// `o`/`c` are the first and last sample of the window;
/// `h`/`l` are the extremes OF THE SAMPLES. A spike between two samples leaves
/// no trace. Do not build wick analysis or a "did the price touch X?" test on
/// these bars.
///
/// The gateway `candles` WS channel carries this SAME bar, wrapped in the
/// `WsCandleFrame` envelope. The channel is served by the gateway only.
export interface Candle {
  /// Bar open timestamp (ms, bucket-aligned).
  t: number;
  /// Bar close timestamp (ms) — `t + interval − 1`.
  T: number;
  /// Market symbol (e.g. `"BTC"`).
  s: string;
  /// Interval token (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`).
  i: string;
  /// Open price, whole-USDC decimal string.
  o: string;
  /// Close price, whole-USDC decimal string.
  c: string;
  /// High price, whole-USDC decimal string.
  h: string;
  /// Low price, whole-USDC decimal string.
  l: string;
  /// Filled bar: `true` when the gateway invented this bar (carry-forward for
  /// an empty bucket, or a seed bar), `false` when real samples built it. Test
  /// this, never `n === 0`.
  f: boolean;
  /// Base-asset volume, decimal string. ABSENT when the gateway cannot prove
  /// trade coverage for this bucket. An absent field means "no volume data";
  /// a `"0"` would mean "no trades". Never default this to zero.
  v?: string;
  /// Quote volume, decimal string. Absent under the same coverage rule as `v`.
  q?: string;
  /// Trade count in the bucket. Absent under the same coverage rule as `v`.
  n?: number;
}

/// `candle_snapshot` — historical price bars for `(coin, interval, candle_type)`.
/// The REST companion to the live `candles` WS channel; bars come oldest-first,
/// the newest element is the still-forming bar.
///
/// The series is GAPLESS: a window with no sample carries the previous close
/// forward as a flat bar (`o = h = l = c`, `f = true`). A bar needs no trade,
/// because a price exists at all times.
///
/// GATEWAY-served, not node: candles are derived display data — query the
/// gateway `/info`; a bare node returns `unknown info type: candle_snapshot`.
/// `{candles: []}` is the honest-empty answer for a market with no history in
/// that series — for example a spot pair asked for `oracle`.
export interface CandleSnapshot {
  /// Price bars, oldest first.
  candles: Candle[];
}

/// One approved agent inside `AccountOverview.agents`.
export interface AgentEntry {
  /// Approved agent wallet address (0x).
  agent: string;
  /// Optional agent label the node emits (absent when unnamed).
  name?: string;
  /// Agent approval expiry (consensus ms); `null` for a never-expiring approval.
  expires_at: number | null;
}

/// One sub-account inside `AccountOverview.sub_accounts`.
export interface SubAccountEntry {
  /// Sub-account index under the parent.
  index: number;
  /// Sub-account address (0x).
  address: string;
  /// Sub-account equity, whole-USDC decimal string (`"0"` when uncommitted).
  equity: string;
}

/// One MIP-3 auction bid.
export interface Mip3Bid {
  /// Bidder address (0x).
  bidder: string;
  /// Bid amount, decimal string.
  amount: string;
  /// Bid submission timestamp (consensus ms).
  submitted_at: number;
  /// Bid tag (e.g. the proposed market name).
  tag: string;
}

/// `mip3_active_bids` — MIP-3 permissionless perp-deploy auction snapshot.
export interface Mip3ActiveBids {
  /// Current auction round.
  auction_round: number;
  /// Leading bid amount, decimal string.
  current_bid: string;
  /// Current winning bidder (0x), or `null` if none.
  current_winner: string | null;
  /// Auction close timestamp (consensus ms).
  auction_end: number;
  /// Auction start timestamp (consensus ms).
  started_at: number;
  /// Bids.
  bids: Mip3Bid[];
}

/// The `resting` branch of an `OrderStatusInfo` — a live order in a perp or
/// spot book.
export interface RestingOrderStatus {
  /// Server order id, a decimal-digit STRING.
  oid: string;
  /// Market symbol (perp `"MTF"`) or spot pair name (`"MTF/USDC"`).
  coin: string;
  /// Order side token.
  side: TradeSide;
  /// Resting price, tick-snapped normalized decimal string.
  px: string;
  /// Remaining size, normalized decimal string.
  sz: string;
  /// Insertion timestamp (consensus ms).
  inserted_at: number;
  /// Client order id (`0x`-hex), or `null` when the order carried none.
  cloid: string | null;
}

/// The `triggered` branch of an `OrderStatusInfo` — a parked TP / SL / stop
/// entry awaiting its mark cross.
export interface TriggerOrderStatus {
  /// Server order id, a decimal-digit STRING.
  oid: string;
  /// Market symbol (perp `"MTF"`) or spot pair name (`"MTF/USDC"`).
  coin: string;
  /// Order side token.
  side: TradeSide;
  /// Trigger price, tick-snapped normalized decimal string.
  trigger_px: string;
  /// `true` = fire when the mark rises to `trigger_px`; `false` = when it falls.
  trigger_above: boolean;
  /// Order size, normalized decimal string.
  sz: string;
  /// Registration timestamp (consensus ms).
  registered_at: number;
  /// Whether the trigger has already fired.
  fired: boolean;
  /// `true` = market trigger (`limit_px` is `null`); `false` = limit trigger.
  is_market: boolean;
  /// Limit price for a limit trigger, normalized decimal string; `null` for a
  /// market trigger.
  limit_px: string | null;
  /// Scaled-TP/SL ladder handle — same rule as `OrderTrigger.group`. Absent
  /// unless this leg belongs to a ladder.
  group?: number;
  /// Trailing callback — same rule as `OrderTrigger.trail_px`. Absent on a
  /// static level; when present, `trigger_px` is the RATCHETED level.
  trail_px?: string;
}

/// `order_status` — single-order lifecycle lookup by `oid` or `cloid`. A
/// `status`-tagged union; resolution order is resting → triggered → filled.
///
/// A `cloid`-only query resolves resting / triggered hits only — the fill ring
/// is oid-keyed, so a cloid that hit no live order returns `unknown`.
export type OrderStatusInfo =
  | { status: 'resting'; order: RestingOrderStatus }
  | { status: 'triggered'; trigger: TriggerOrderStatus }
  | { status: 'filled'; fills: UserFill[]; total_filled_sz: string }
  | { status: 'canceled'; outcome: OrderOutcome }
  | { status: 'cancel_rejected'; outcome: OrderOutcome }
  | { status: 'rejected'; outcome: OrderOutcome }
  | { status: 'unknown' };

/// The terminal record behind the `canceled` / `cancel_rejected` / `rejected`
/// branches of an `OrderStatusInfo`.
///
/// It is a SEPARATE key from the `order` of a live resting hit. The two answer
/// different questions, and one name over two field sets is how a caller reads
/// the wrong one.
///
/// The node carries no size on a terminal record. A cancel event names the
/// order, not its size, and an order with even one fill answers `filled`
/// before the terminal branch runs — so a filled size here could only ever be
/// zero. There is no `sz`, `filled_sz` or `cloid` field.
export interface OrderOutcome {
  /// Server order id, a decimal-digit STRING. `null` on an order the node
  /// rejected by `cloid` before it held an id.
  oid: string | null;
  /// Market symbol (perp `"MTF"`) or spot pair name (`"MTF/USDC"`).
  coin: string;
  /// Order side token. `null` on a cancel outcome — a cancel names the order,
  /// not its side.
  side: TradeSide | null;
  /// Consensus timestamp the order reached this state (ms).
  time: number;
  /// Why the order ended; `null` on a successful cancel. Branch on `status`,
  /// never on this string.
  reason: string | null;
}

/// One record inside a `HistoricalOrders` response. The node fold emits the
/// eight Always fields; a gateway archive row is a documented SUPERSET that
/// adds the converted `limit_px` / `avg_px` / `sz` / `orig_sz` / `total_sz`
/// plus order-control fields — all optional here.
export interface HistoricalOrder {
  /// Server order id, a decimal-digit STRING.
  oid: string;
  /// Market symbol (perp `"MTF"`) or spot pair name (`"MTF/USDC"`).
  coin: string;
  /// Side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Order status: `"resting"`, `"filled"`, `"error"` or `"noop"`. One record
  /// per transition, and a maker order gets one `"filled"` record per block it
  /// executed in — so `"filled"` is not a terminal flag and `oid` repeats.
  /// Treat it as an open set: match the value, never assume the list is closed.
  /// `"noop"` is an ACCEPTED order that changed nothing; do not count it as a
  /// rejection. Not live yet — it ships with the next node release.
  status: string;
  /// Fill price, 8-dp tape decimal string.
  px: string;
  /// Total filled size, normalized decimal string (trailing zeros trimmed).
  filled_sz: string;
  /// Order timestamp (consensus ms).
  time: number;
  /// Transaction hash (`0x`-hex), or the empty-string sentinel.
  hash: string;
  /// Committed block height. Node fold Always; a gateway archive row omits it.
  block?: number;
  /// Limit price, 8-dp tape decimal string (gateway archive superset).
  limit_px?: string;
  /// Average fill price, 8-dp tape decimal string (gateway archive superset).
  avg_px?: string;
  /// Filled size, normalized decimal string (gateway archive superset).
  sz?: string;
  /// Original order size, normalized decimal string (gateway archive superset).
  orig_sz?: string;
  /// Total order size, normalized decimal string (gateway archive superset).
  total_sz?: string;
  /// Time-in-force token (gateway archive superset). `null` on a maker
  /// execution record: a fill does not carry the order's time in force. Read
  /// it from that order's own `"resting"` record, same `oid`.
  tif?: string | null;
  /// Whether the order was reduce-only (gateway archive superset).
  reduce_only?: boolean;
  /// Client order id (`0x`-hex) (gateway archive superset).
  cloid?: string;
  /// Cancel reason (gateway archive superset).
  cancel_reason?: string;
  /// Error label (gateway archive superset).
  error?: string;
}

/// `historical_orders` — the account's past (executed) orders, keyed by
/// `address`. Optional `limit` caps the most-recent records.
export interface HistoricalOrders {
  /// Resolved account address (0x). Absent on a no-archive gateway's typed-empty
  /// fallback (it omits `address`); present on the real archive path.
  address?: string;
  /// Orders, newest first (one record per oid).
  orders: HistoricalOrder[];
}

/// One realized-funding row inside a `UserFunding` response.
export interface UserFundingRecord {
  /// Market symbol the payment settled on (`"MTF"`).
  coin: string;
  /// Payment timestamp (consensus ms).
  time: number;
  /// Signed funding payment in whole USDC, verbatim decimal string. May carry
  /// up to ~28 significant digits — DO NOT re-parse through a fixed-precision
  /// decimal, which would corrupt it; keep it as a string.
  usdc: string;
  /// Signed position size at settlement, decimal string.
  szi: string;
  /// The funding rate charged, decimal string.
  funding_rate: string;
}

/// `user_funding` — per-account realized funding-payment history, keyed by
/// `address`. Optional `start_time` / `end_time` (u64 ms) are echoed. `fundings`
/// is `[]` on a bare node today; the gateway archive leg returns real rows.
export interface UserFunding {
  /// Resolved account address (0x). Absent on a no-archive gateway's typed-empty
  /// fallback; present on the real archive path.
  address?: string;
  /// Echoed window start (ms): `null` when the node echoed it as absent, or
  /// absent entirely on the archive-backed path (the indexer echoes neither).
  start_time?: number | null;
  /// Echoed window end (ms); same absence semantics as `start_time`.
  end_time?: number | null;
  /// Funding payments.
  fundings: UserFundingRecord[];
}

/// `user_ledger_updates` — per-account balance-ledger deltas (node kind), keyed
/// by `address`. Optional `start_time` / `end_time` are echoed.
///
/// `updates` is `[]` on the node today, and the future node record shape is
/// doc-locked and DIFFERS from the gateway union (`amount` / `amount_units` vs
/// `delta`) — so the record type is deliberately left as raw JSON (`unknown[]`).
/// For the gateway-served normalized union use `userNonFundingLedgerUpdates`.
export interface UserLedgerUpdates {
  /// Resolved account address (0x).
  address: string;
  /// Echoed window start (ms), `null` when the request omitted it.
  start_time: number | null;
  /// Echoed window end (ms), `null` when the request omitted it.
  end_time: number | null;
  /// Ledger deltas — untyped pending the retention-seam record shape.
  updates: unknown[];
}

/// One record inside a `UserNonFundingLedgerUpdates` union. Two row shapes
/// (money-movement / trade) share `coin` + `time`; the rest varies per row.
export interface LedgerUpdate {
  /// Symbol resolved from the row's id space (token id for money movements,
  /// market id for trade rows). E.g. `"USDC"`, `"PURR"`, `"MTF"`.
  coin: string;
  /// Event timestamp (consensus ms).
  time: number;
  /// Event kind, e.g. `"deposit"` / `"spot_transfer"` / `"trade"`.
  kind?: string;
  /// Signed balance delta, decimal string (money-movement rows).
  delta?: string;
  /// Counterparty address (`0x`), when applicable.
  counterparty?: string;
  /// Deterministic trade id (trade rows), a decimal-digit STRING.
  tid?: string;
  /// Realized PnL, decimal string (trade rows).
  realized_pnl?: string;
  /// Fee paid, decimal string (trade rows).
  fee?: string;
  /// Fee token symbol (trade rows).
  fee_token?: string;
}

/// `user_non_funding_ledger_updates` — every NON-TRADING movement of an
/// account's money, keyed by `address`. Optional `start_time` / `end_time`
/// filter the window.
///
/// Funding is excluded — it has `user_funding`. A fill's realized PnL is
/// excluded — it is trading, and it has `user_fills`. In scope: deposits,
/// withdrawals, transfers between accounts and sub-accounts, staking including
/// a reward claim, Earn, and vaults.
///
/// The key WAS camelCase `ledgerUpdates`, the only one on this surface. It is
/// `ledger_updates` now.
export interface UserNonFundingLedgerUpdates {
  /// Ledger rows.
  ledger_updates: LedgerUpdate[];
}

/// One validator's unclaimed delegation reward inside a `DelegatorRewards`.
export interface DelegatorRewardRow {
  /// The validator the stake is delegated to, 0x hex.
  validator: string;
  /// Reward accrued on this delegation and not yet claimed, decimal string.
  unclaimed: string;
  /// When this delegation last paid out (consensus ms). `0` if it never has.
  last_claim_time: number;
}

/// `delegator_rewards` — one account's staking rewards, keyed by `address`.
///
/// `claimable_rewards` MAY EXCEED the sum of `rewards[].unclaimed`. It adds a
/// per-account carry that no validator row holds, so claim against the total and
/// use the rows only to see which validator earned what.
export interface DelegatorRewards {
  /// Echo of the requested account, 0x hex.
  address: string;
  /// Everything the account can claim now, decimal string. The authoritative
  /// total.
  claimable_rewards: string;
  /// One row per active delegation. Empty when the account delegates nothing.
  rewards: DelegatorRewardRow[];
}
