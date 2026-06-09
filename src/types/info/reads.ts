// Book / trade / account-history response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md. Field
// names are the exact snake_case keys the node emits inside `{type, data}.data`.
// Money magnitudes that can exceed 2^53 are typed `string`.

/// One resting order inside an `OpenOrders` response.
export interface OpenOrder {
  /// Server order id.
  oid: number;
  /// Asset / market id the order rests on.
  market_id: number;
  /// Order side.
  side: 'bid' | 'ask';
  /// Resting price, fixed-point decimal string.
  px: string;
  /// Remaining size, fixed-point decimal string.
  size: string;
  /// Insertion timestamp (consensus ms).
  inserted_at_ms: number;
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
  /// Level price, fixed-point decimal string.
  px: string;
  /// Summed size at the level, fixed-point decimal string.
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

/// `recent_trades` — market-scoped trade tape (honest-empty today).
export interface RecentTrades {
  /// Echoed market id.
  market_id: number;
  /// Timestamp of the last trade (`0` if none).
  last_trade_ms: number;
  /// Empty until the trade indexer lands.
  trades: unknown[];
}

/// `user_fills` — account-scoped fill history (honest-empty today).
export interface UserFills {
  /// Resolved account address (0x).
  address: string;
  /// Echoed only when the request used `account_id`.
  account_id?: number;
  /// Empty until the fill indexer lands.
  fills: unknown[];
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
