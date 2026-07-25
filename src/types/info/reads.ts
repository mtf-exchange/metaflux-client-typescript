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
  /// Server order id.
  oid: number;
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

/// One public trade record (shared by `recent_trades` / `trades_by_time`; the
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
  tid: number;
  /// Committed block height the trade landed in.
  block: number;
  /// Transaction hash of the originating taker action (`0x`-hex); empty
  /// string when the trade has no signed taker action (system fills).
  hash: string;
}

/// `recent_trades` — market-scoped trade tape, keyed by `coin`. Newest first.
export interface RecentTrades {
  /// Echoed market symbol.
  coin: string;
  /// Timestamp of the last trade (consensus ms; `0` if none).
  last_trade: number;
  /// Recent trades (bounded ring; deep history is the indexer's job).
  trades: TradeRecord[];
}

/// `trades_by_time` — the trade tape filtered to an inclusive `[start_time,
/// end_time]` window over each record's consensus `time`. Ring order
/// (oldest first). Same bounded ring as `recent_trades`.
export interface TradesByTime {
  /// Echoed market symbol.
  coin: string;
  /// Echoed window start (ms), `null` when the request omitted it.
  start_time: number | null;
  /// Echoed window end (ms), `null` when the request omitted it.
  end_time: number | null;
  /// In-window trades.
  trades: TradeRecord[];
}

/// One fill inside a `UserFills` / `UserFillsByTime` history. Also the `filled`
/// branch of an `OrderStatusInfo`.
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
  /// digits). SPOT: the raw integer plane (`szd=0` pin) — no fraction part.
  sz: string;
  /// Fill timestamp (consensus ms).
  time: number;
  /// This party's order id.
  oid: number;
  /// Deterministic trade id (shared by both legs of the print).
  tid: number;
  /// Fee this party paid, whole-USDC decimal string.
  fee: string;
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
}

/// `user_fills` — account-scoped fill history, keyed by `address`. Newest
/// first; a bounded recent window (the gateway merges deep archive history
/// when available).
export interface UserFills {
  /// Resolved account address (0x).
  address: string;
  /// Fills.
  fills: UserFill[];
}

/// `user_fills_by_time` — fill history filtered to an inclusive `[start_time,
/// end_time]` window over each record's consensus `time`. Oldest first.
export interface UserFillsByTime {
  /// Resolved account address (0x).
  address: string;
  /// Echoed window start (ms), `null` when the request omitted it.
  start_time: number | null;
  /// Echoed window end (ms), `null` when the request omitted it.
  end_time: number | null;
  /// In-window fills (same record shape as `user_fills`).
  fills: UserFill[];
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

/// One `predicted_fundings` entry — per-market predicted funding.
export interface PredictedFunding {
  /// Market symbol.
  coin: string;
  /// Predicted rate for the next settlement (clamped — the rate that will
  /// actually be charged), decimal string.
  predicted_rate: string;
  /// Next settlement boundary (unix ms, aligned to the per-asset funding
  /// interval; `0` only when no block is committed yet).
  next_funding_ts: number;
}

/// One OHLCV bar from the `candle_snapshot` read / `candles` WS channel.
///
/// Compact keys (one shape across REST history and the live WS bar):
/// `t`/`T` bar open/close epoch-ms, `s` symbol, `i` interval token,
/// `o`/`c`/`h`/`l` whole-USDC decimal strings, `v` base volume, `q` quote
/// (USD) volume, `n` fill count.
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
  /// Base-asset volume in the bar, decimal string (coin size, not notional).
  v: string;
  /// Quote / USD (notional) volume in the bar, decimal string.
  q: string;
  /// Fill count in the bar.
  n: number;
}

/// `candle_snapshot` — historical OHLCV bars for `(coin, interval)`. The REST
/// companion to the live `candles` WS channel; bars come oldest-first, the
/// newest element is the still-forming bar.
///
/// GATEWAY-served, not node: candles are derived display data — query the
/// gateway `/info`; a bare node returns `unknown info type: candle_snapshot`.
/// `{candles: []}` is the honest-empty answer for an unsupported interval or
/// a market with no indexed trades.
export interface CandleSnapshot {
  /// OHLCV bars, oldest first.
  candles: Candle[];
}

/// `block_info` — committed block metadata.
export interface BlockInfo {
  /// Latest committed block height.
  height: number;
  /// Consensus round of that block.
  round: number;
  /// Current epoch.
  epoch: number;
  /// Block timestamp (consensus ms).
  timestamp: number;
  /// Block hash (0x + 32 bytes).
  block_hash: string;
}

/// One approved agent inside an `Agents` response.
export interface AgentEntry {
  /// Approved agent wallet address (0x).
  agent: string;
  /// Optional agent label the node emits (absent when unnamed).
  name?: string;
  /// Agent approval expiry (consensus ms); `null` for a never-expiring approval.
  expires_at: number | null;
}

/// `agents` — approved agent / API wallets for an account, keyed by `address`.
export interface Agents {
  /// Resolved master address (0x).
  address: string;
  /// Approved agents.
  agents: AgentEntry[];
}

/// One sub-account inside a `SubAccounts` response.
export interface SubAccountEntry {
  /// Sub-account index under the parent.
  index: number;
  /// Sub-account address (0x).
  address: string;
  /// Sub-account equity, whole-USDC decimal string (`"0"` when uncommitted).
  equity: string;
}

/// `sub_accounts` — sub-accounts of an account, keyed by `address`.
export interface SubAccounts {
  /// Resolved parent address (0x).
  address: string;
  /// Sub-accounts.
  sub_accounts: SubAccountEntry[];
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
  /// Server order id.
  oid: number;
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
  /// Server order id.
  oid: number;
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
}

/// `order_status` — single-order lifecycle lookup by `oid` or `cloid`. A
/// `status`-tagged union; resolution order is resting → triggered → filled.
///
/// A `cloid`-only query resolves resting / triggered hits only — the fill ring
/// is oid-keyed, so a cloid that hit no live order returns `unknown`.
export type OrderStatusInfo =
  | { status: 'resting'; order: RestingOrderStatus }
  | { status: 'triggered'; trigger: TriggerOrderStatus }
  | { status: 'filled'; fill: UserFill }
  | { status: 'unknown' };

/// One record inside a `HistoricalOrders` response. The node fold emits the
/// eight Always fields; a gateway archive row is a documented SUPERSET that
/// adds the converted `limit_px` / `avg_px` / `sz` / `orig_sz` / `total_sz`
/// plus order-control fields — all optional here.
export interface HistoricalOrder {
  /// Server order id.
  oid: number;
  /// Market symbol (perp `"MTF"`) or spot pair name (`"MTF/USDC"`).
  coin: string;
  /// Side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Order status. `"filled"` only today (the committed ring carries executed
  /// legs); cancel / reject / expire arrive with the retention seam.
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
  /// Time-in-force token (gateway archive superset).
  tif?: string;
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
  /// Deterministic trade id (trade rows).
  tid?: number;
  /// Realized PnL, decimal string (trade rows).
  realized_pnl?: string;
  /// Fee paid, decimal string (trade rows).
  fee?: string;
  /// Fee token symbol (trade rows).
  fee_token?: string;
}

/// `user_non_funding_ledger_updates` — the gateway-served normalized ledger
/// union, keyed by `address`. Optional `start_time` / `end_time` filter the
/// window.
///
/// NOTE the camelCase collection key `ledgerUpdates` — it is the only camelCase
/// key on this read surface (the gateway passthrough emits it verbatim).
export interface UserNonFundingLedgerUpdates {
  /// Ledger union rows.
  ledgerUpdates: LedgerUpdate[];
}
