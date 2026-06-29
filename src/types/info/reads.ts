// Book / trade / account-history response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md. Field
// names are the exact snake_case keys the node emits inside `{type, data}.data`.
// Money magnitudes that can exceed 2^53 are typed `string`.

/// One resting order inside an `OpenOrders` response.
///
/// `px` / `size` are CANONICAL decimal strings (positive price for **both**
/// sides; size in whole units) — the node tick-snaps the price and renders the
/// size in the per-asset plane, so no client-side rescaling is needed. `side`
/// is lowercase `"bid"`/`"ask"`. `oid` / `market_id` / `inserted_at_ms` are
/// bare integers.
///
/// LIVE GATEWAY GAP: a resting order currently reads back with `oid: 0` and
/// `inserted_at_ms: 0` even though it is on the book — so an order is NOT
/// reliably cancellable by the `oid` from this snapshot, and it carries no
/// `cloid`. Until the gateway populates `oid`, the oid-independent workaround
/// for reconcile / ghost-sweep is the `cancel_all_orders` exchange action
/// (`Client.cancelAllOrders`, keyed by account / asset) rather than per-oid
/// cancels.
export interface OpenOrder {
  /// Server order id. See the note: currently `0` on the gateway.
  oid: number;
  /// Asset / market id the order rests on.
  market_id: number;
  /// Order side, lowercase `"bid"` / `"ask"`.
  side: 'bid' | 'ask';
  /// Resting price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Remaining size, canonical decimal string (whole units).
  size: string;
  /// Insertion timestamp (consensus ms). See the note: currently `0`.
  inserted_at_ms: number;
  /// Client order id (`0x`-hex), or `null` when the order carried none. Present
  /// once the gateway populates per-order cloid; may be absent on older nodes.
  cloid?: string | null;
}

/// `open_orders` — account-scoped resting orders across every perp book.
export interface OpenOrders {
  /// Resolved account address (0x).
  address: string;
  /// Echoed only when the request used `account_id`.
  account_id?: number;
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

/// `l2_book` — market-scoped aggregated bid/ask levels.
export interface L2Book {
  /// Echoed market id.
  market_id: number;
  /// Bid side (best-first, descending price).
  bids: L2Level[];
  /// Ask side (ascending price).
  asks: L2Level[];
}

/// One trade inside a `RecentTrades` tape.
export interface RecentTrade {
  /// Side that took liquidity, lowercase `"bid"` / `"ask"`.
  side: 'bid' | 'ask';
  /// Trade price, decimal string.
  px: string;
  /// Trade size (base units), decimal string.
  size: string;
  /// Trade timestamp (consensus ms).
  time_ms: number;
  /// Committed block height the trade landed in.
  block: number;
  /// Transaction hash (`0x` + 32 bytes) the trade landed in.
  hash: string;
}

/// `recent_trades` — market-scoped trade tape.
export interface RecentTrades {
  /// Echoed market id.
  market_id: number;
  /// Timestamp of the last trade (`0` if none).
  last_trade_ms: number;
  /// Recent trades (empty until the trade indexer is wired).
  trades: RecentTrade[];
}

/// One fill inside a `UserFills` history.
export interface UserFill {
  /// Asset / market id the fill is on.
  market_id: number;
  /// Fill side, lowercase `"bid"` / `"ask"`.
  side: 'bid' | 'ask';
  /// Fill price, decimal string.
  px: string;
  /// Fill size (base units), decimal string.
  size: string;
  /// Fee paid on the fill, decimal string.
  fee: string;
  /// Server order id the fill belongs to.
  oid: number;
  /// Fill timestamp (consensus ms).
  time_ms: number;
  /// Committed block height the fill landed in.
  block: number;
  /// Transaction hash (`0x` + 32 bytes) the fill landed in.
  hash: string;
}

/// `user_fills` — account-scoped fill history.
export interface UserFills {
  /// Resolved account address (0x).
  address: string;
  /// Echoed only when the request used `account_id`.
  account_id?: number;
  /// Fills (empty until the fill indexer is wired).
  fills: UserFill[];
}

/// One funding premium sample.
export interface FundingSample {
  /// Sample timestamp (consensus ms).
  ts_ms: number;
  /// Funding premium sample (signed), decimal string.
  premium: string;
}

/// `funding_history` — market-scoped funding premium samples.
export interface FundingHistory {
  /// Echoed market id.
  market_id: number;
  /// Ordered ring of `(ts_ms, premium)` samples.
  samples: FundingSample[];
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
  /// Block hash (0x + 32 bytes); all-zero until plumbed into read state.
  block_hash: string;
}

/// One approved agent inside an `Agents` response.
export interface AgentEntry {
  /// Approved agent wallet address (0x).
  agent: string;
  /// Agent approval expiry (consensus ms).
  expires_at_ms: number;
}

/// `agents` — approved agent / API wallets for an account.
export interface Agents {
  /// Resolved master address (0x).
  address: string;
  /// Echoed only when the request used `account_id`.
  account_id?: number;
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

/// `sub_accounts` — sub-accounts of an account.
export interface SubAccounts {
  /// Resolved parent address (0x).
  address: string;
  /// Echoed only when the request used `account_id`.
  account_id?: number;
  /// Sub-accounts.
  sub_accounts: SubAccountEntry[];
}

/// One OHLCV bar from the `candle` `/info` read.
///
/// The REST companion to the live `candles` WS channel: the WS pushes the
/// forming bar as trades land, this read returns the closed history. Bars are
/// oldest-first by `open_time`; the newest element is the still-forming bar.
///
/// **Price plane.** `open` / `close` / `high` / `low` are whole-USDC human-dollar
/// decimal strings (`"67042.50"`, tick-snapped) — the SAME canonical plane the
/// WS `candles` frame now emits, so REST history and the live WS bar line up
/// with no rescaling. `volume` is base units (coin size, NOT notional);
/// `num_trades` is a fill count, not notional.
///
/// GATEWAY-served, not node: candles are derived display data folded from the
/// public trade stream — not committed chain state, so they must be queried
/// against the **gateway** (`<net>-gateway.mtf.exchange/info`); a bare node
/// returns `unknown info type: candle`.
export interface Candle {
  /// Echoed market symbol (e.g. `"BTC"`).
  coin: string;
  /// Echoed bucket token (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`).
  interval: string;
  /// Bar open timestamp (ms, bucket-aligned).
  open_time: number;
  /// Bar close timestamp (ms) — `open_time + interval − 1`.
  close_time: number;
  /// Open price, whole-USDC decimal string.
  open: string;
  /// Close price, whole-USDC decimal string.
  close: string;
  /// High price, whole-USDC decimal string.
  high: string;
  /// Low price, whole-USDC decimal string.
  low: string;
  /// Traded base volume in the bar, decimal string (coin size, not notional).
  volume: string;
  /// Quote / USD (notional) volume in the bar, decimal string. Additive; may be
  /// absent on older gateways that only emitted base `volume`.
  q?: string;
  /// Fill count in the bar.
  num_trades: number;
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
