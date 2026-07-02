// Book / trade / account-history response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md. Field
// names are the exact snake_case keys the node emits inside `{type, data}.data`.
// Money magnitudes that can exceed 2^53 are typed `string`.
//
// KEYING (consolidated surface): market-scoped reads take `coin` (the market
// SYMBOL, e.g. `"BTC"`); account-scoped reads take `address` (0x hex). The
// numeric `market_id` / `asset_id` / `account_id` request params are gone.

/// Side token on trade / fill records: `"B"` = buy/bid, `"A"` = sell/ask.
export type TradeSide = 'B' | 'A';

/// One resting order inside an `OpenOrders` response.
///
/// `px` / `size` are CANONICAL decimal strings (positive price for **both**
/// sides, tick-snapped whole-USDC; size in whole units) — no client-side
/// rescaling is needed. `side` is lowercase `"bid"`/`"ask"`.
export interface OpenOrder {
  /// Server order id.
  oid: number;
  /// Market symbol the order rests on (e.g. `"BTC"`).
  coin: string;
  /// Order side, lowercase `"bid"` / `"ask"`.
  side: 'bid' | 'ask';
  /// Resting price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Remaining size, canonical decimal string (whole units).
  size: string;
  /// Client order id (`0x`-hex), or `null` when the order carried none.
  cloid: string | null;
  /// Insertion timestamp (consensus ms).
  inserted_at_ms: number;
}

/// `open_orders` — account-scoped resting orders across every perp book.
export interface OpenOrders {
  /// Resolved account address (0x).
  address: string;
  /// Resting orders.
  orders: OpenOrder[];
}

/// One aggregated L2 book level.
export interface L2Level {
  /// Level price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Summed size at the level, canonical decimal string (whole units).
  size: string;
  /// Resting orders at the level.
  n_orders: number;
}

/// `l2_book` — market-scoped aggregated bid/ask levels, keyed by `coin`.
export interface L2Book {
  /// Echoed market symbol.
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
  /// Timestamp of the last trade (`0` if none).
  last_trade_ms: number;
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

/// One fill inside a `UserFills` / `UserFillsByTime` history.
export interface UserFill {
  /// Numeric asset id the fill executed on. NOTE: unlike the trade tape, the
  /// committed fill ring still renders the numeric id here — resolve symbols
  /// via `markets`.
  coin: number;
  /// This leg's side token — `"B"` = buy, `"A"` = sell.
  side: TradeSide;
  /// Execution price, whole-USDC decimal string.
  px: string;
  /// Filled size, whole units as a decimal string.
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
  /// Signed leg size BEFORE the fill, whole units (signed) decimal string.
  start_position: string;
  /// Committed block height the fill settled in.
  block: number;
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
  ts_ms: number;
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
  next_funding_time: number;
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
  timestamp_ms: number;
  /// Block hash (0x + 32 bytes).
  block_hash: string;
}

/// One approved agent inside an `Agents` response.
export interface AgentEntry {
  /// Approved agent wallet address (0x).
  agent: string;
  /// Agent approval expiry (consensus ms).
  expires_at_ms: number;
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
  submitted_at_ms: number;
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
  auction_end_ms: number;
  /// Auction start timestamp (consensus ms).
  started_at_ms: number;
  /// Bids.
  bids: Mip3Bid[];
}
