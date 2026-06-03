// Response interfaces for the MTF-native `POST /info` read surface.
//
// Source of truth (read these, do not guess): the node handlers
//   metaflux/crates/api-node/src/rest/info/{reads,markets,hl_parity}.rs
// and the KB spec metaflux-knowledges/api/rest/info.md. Every field name here
// is the EXACT snake_case key the node emits inside the `{type, data}`
// envelope's `data` object (the envelope itself is unwrapped by `InfoApi`).
//
// Money-magnitude convention: any value that can exceed JS
// `Number.MAX_SAFE_INTEGER` (2^53) — u128 / i128 / decimal magnitudes — is
// typed `string` to match the node's decimal-string encoding and avoid silent
// precision loss. Ids / counts / bps / leverage that the node emits as JSON
// numbers within safe range stay `number`. Optional fields the node only emits
// conditionally (e.g. echoed `account_id`) are `?`.

/// `node_info` — static node identity + protocol version.
export interface NodeInfo {
  /// Network variant: `"devnet"`, `"testnet"`, or `"mainnet"`.
  network: string;
  /// EIP-712 chain id this node is pinned to.
  chain_id: number;
  /// Wire-protocol version (semver string).
  protocol_version: string;
  /// This node's index in the active validator set; `null` until published.
  validator_index: number | null;
  /// Operator-published build identifier (short hex).
  build_commit: string;
  /// Process uptime in seconds.
  uptime_seconds: number;
}

/// Account liquidation tier — see `concepts/tiered-liquidation.md`.
export type Tier = 'Safe' | 'T0' | 'T1' | 'T2' | 'T3';

/// Account margin mode label.
export type MarginMode = 'Cross' | 'Isolated' | 'StrictIso';

/// One open position inside an `AccountState`.
export interface AccountPosition {
  /// Asset id.
  asset: number;
  /// Signed position size, fixed-point as a decimal string.
  size: string;
  /// Volume-weighted entry price, decimal string (whole-USDC plane).
  entry_px: string;
  /// Unrealised PnL (signed), decimal string (same unit as `account_value`).
  unrealised_pnl: string;
  /// Whether this position uses isolated margin.
  isolated: boolean;
  /// Per-asset leverage multiple.
  leverage: number;
}

/// Per-account balances inside an `AccountState`. `usdc` is the cross USDC
/// collateral; `spot` maps spot-asset symbol → balance, both decimal strings.
export interface Balances {
  /// USDC collateral (cross account value), decimal string.
  usdc: string;
  /// Spot balances keyed by asset symbol, decimal strings.
  spot: Record<string, string>;
}

/// `account_state` — rich per-account snapshot keyed by `address`.
export interface AccountState {
  /// Echo of the requested 0x address.
  address: string;
  /// Equity including unrealised PnL, USDC base units (u128 string).
  account_value: string;
  /// Equity minus initial margin held by open positions (u128 string).
  free_collateral: string;
  /// Maintenance margin requirement (u128 string).
  maint_margin: string;
  /// Initial margin requirement (u128 string).
  init_margin: string;
  /// `account_value - maint_margin` (i128 string; can be negative).
  health: string;
  /// Liquidation tier.
  tier: Tier;
  /// Margin mode.
  margin_mode: MarginMode;
  /// Portfolio-margin opt-in state.
  pm_enabled: boolean;
  /// Per-asset open positions.
  positions: AccountPosition[];
  /// Account balances.
  balances: Balances;
}

/// Per-market funding parameters inside a `MarketInfo`.
export interface Funding {
  /// Latest funding premium sample, bps string.
  rate_per_hr: string;
  /// Per-hour funding cap, bps string.
  cap_per_hr: string;
  /// Funding interval in milliseconds.
  interval_ms: number;
  /// Next funding payment timestamp (unix ms; `0` until a sample exists).
  next_payment_ts: number;
}

/// `market_info` / `markets` element — rich per-market metadata.
///
/// `mark_px` is the on-book mark in the 1e8 fixed-point plane; `oracle_px` is
/// the index price in the whole-USDC plane. Both are `"0"` when unset. (These
/// two price fields are emitted by the node `market_record` builder; they are
/// not yet listed in the KB field table but are part of the live wire shape.)
export interface MarketInfo {
  /// Canonical asset id.
  asset_id: number;
  /// Human-readable market name (e.g. `"BTC"`).
  name: string;
  /// Market kind — currently always `"Perp"`.
  kind: string;
  /// On-book mark price, 1e8 fixed-point as a decimal string.
  mark_px: string;
  /// Oracle/index price, whole-USDC plane as a decimal string.
  oracle_px: string;
  /// Tick size (smallest price increment), fixed-point string.
  tick_size: string;
  /// Step size (smallest size increment / lot size), fixed-point string.
  step_size: string;
  /// Minimum order size, fixed-point string.
  min_order: string;
  /// Maximum leverage multiple.
  max_leverage: number;
  /// Maintenance margin ratio, bps string.
  maint_margin_ratio: string;
  /// Initial margin ratio, bps string.
  init_margin_ratio: string;
  /// Funding parameters.
  funding: Funding;
  /// Mark-price source descriptor.
  mark_source: string;
  /// Whether frequent-batch-auction matching is enabled for this market.
  fba_enabled: boolean;
  /// Open interest, fixed-point as a decimal string.
  open_interest: string;
}

/// `vault_state` — per-vault snapshot keyed by vault `address`.
export interface VaultState {
  /// Vault on-chain address (0x).
  vault: string;
  /// Vault display name (derived `vault:<id>` today).
  name: string;
  /// TVL = high-water-mark NAV proxy, USD cents as a decimal string.
  tvl: string;
  /// Share price (NAV / total shares), decimal string.
  share_price: string;
  /// Distinct depositor count.
  depositor_count: number;
  /// High-water mark, USD cents as a decimal string.
  high_water_mark: string;
  /// Leader management/performance fee in bps.
  performance_fee_bps: number;
  /// Follower withdrawal lock in ms.
  lock_period_ms: number;
  /// Vault strategy / kind label (`"User"` / `"Metaliquidity"`).
  strategy: string;
}

/// One delegation entry inside a `StakingState`.
export interface Delegation {
  /// Validator address (0x).
  validator: string;
  /// Staked amount, decimal string.
  amount: string;
  /// Last-claim / since timestamp (unix ms).
  since_ts: number;
  /// Accrued but unclaimed rewards, decimal string.
  pending_rewards: string;
}

/// One pending-unstake entry inside a `StakingState`.
export interface PendingUnstake {
  /// Amount being unbonded, decimal string.
  amount: string;
  /// Earliest claim / maturity timestamp (unix ms).
  matures_at_ts: number;
}

/// `staking_state` — per-account staking snapshot keyed by `address`.
export interface StakingState {
  /// Echo of the requested 0x address.
  address: string;
  /// Total staked across all delegations, decimal string.
  total_staked: string;
  /// Active per-validator delegations.
  delegations: Delegation[];
  /// Pending unbond entries.
  pending_unstakes: PendingUnstake[];
}

/// One fee tier inside a `FeeSchedule`.
export interface FeeTier {
  /// 30-day volume threshold for this tier, decimal string.
  volume_30d: string;
  /// Maker fee, decimal bps string (e.g. `"2.0"`).
  maker_bps: string;
  /// Taker fee, decimal bps string.
  taker_bps: string;
}

/// `fee_schedule` — protocol fee schedule. Fee rates are decimal bps strings;
/// `burn_ratio` is a decimal fraction string (`"0.30"` = 30%).
export interface FeeSchedule {
  /// Volume-tier ladder.
  tiers: FeeTier[];
  /// Builder rebate, decimal bps string.
  builder_rebate_bps: string;
  /// Fraction of fees burned, decimal fraction string.
  burn_ratio: string;
  /// Referrer share, decimal bps string.
  referrer_share_bps: string;
}

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

// ── HL-node parity query types ──────────────────────────────────────────────

/// One spot pair inside `SpotMeta`.
export interface SpotPair {
  /// Pair id.
  id: number;
  /// Pair name (e.g. `"BTC/USDC"`).
  name: string;
  /// Base asset id.
  base: number;
  /// Quote asset id.
  quote: number;
  /// Taker fee (bps); `0` if unset.
  taker_fee_bps: number;
  /// Min notional (USDC cents), decimal string; `"0"` if unset.
  min_notional: string;
  /// Whether the pair is active for trading.
  active: boolean;
}

/// `spot_meta` — spot pair universe.
export interface SpotMeta {
  /// Registered spot pairs.
  pairs: SpotPair[];
}

/// One spot balance inside `SpotClearinghouseState`.
export interface SpotBalance {
  /// Spot asset id.
  asset: number;
  /// Token / pair name, else `asset:<id>`.
  name: string;
  /// Balance, decimal string (truncated toward zero).
  balance: string;
}

/// `spot_clearinghouse_state` — per-account spot token balances.
export interface SpotClearinghouseState {
  /// Echo of the requested 0x address.
  address: string;
  /// Spot balances.
  balances: SpotBalance[];
}

/// `exchange_status` — global trading status.
export interface ExchangeStatus {
  /// Spot trading globally disabled.
  spot_disabled: boolean;
  /// Post-only window end (consensus ms); `0` = none.
  post_only_until_time_ms: number;
  /// Post-only window end (height); `0` = none.
  post_only_until_height: number;
  /// Scheduled upgrade-halt height, or `null` if none.
  scheduled_freeze_height: number | null;
  /// `true` once any MIP-3 market/pair spec is registered.
  mip3_enabled: boolean;
}

/// A trigger detail attached to a `FrontendOpenOrder`.
export interface OrderTrigger {
  /// Trigger price, fixed-point decimal string.
  trigger_px: string;
  /// Whether the trigger fires above (`true`) or below the price.
  trigger_above: boolean;
}

/// One order inside `FrontendOpenOrders` — `open_orders` plus frontend detail.
export interface FrontendOpenOrder {
  /// On-chain order id.
  oid: number;
  /// Asset id.
  market_id: number;
  /// Order side.
  side: 'bid' | 'ask';
  /// Resting price, fixed-point decimal string.
  px: string;
  /// Remaining size, fixed-point decimal string.
  size: string;
  /// Time-in-force.
  tif: 'alo' | 'ioc' | 'gtc';
  /// Client order id (0x), or `null` if none.
  cloid: string | null;
  /// Trigger detail if registered for the oid, else `null`.
  trigger: OrderTrigger | null;
  /// Insertion timestamp (consensus ms).
  inserted_at_ms: number;
}

/// `frontend_open_orders` — resting orders with tif / cloid / trigger detail.
export interface FrontendOpenOrders {
  /// Echo of the requested 0x address.
  address: string;
  /// Orders.
  orders: FrontendOpenOrder[];
}

/// One account flagged for liquidation.
export interface LiquidatableAccount {
  /// Needs-action account address (0x).
  address: string;
  /// BOLE tier.
  tier: 'YellowCard' | 'PartialMarket50' | 'FullMarket' | 'BackstopTakeover';
}

/// `liquidatable` — accounts currently flagged for liquidation.
export interface Liquidatable {
  /// Flagged accounts.
  accounts: LiquidatableAccount[];
}

/// `active_asset_data` — a user's per-asset leverage / margin-mode / max trade.
export interface ActiveAssetData {
  /// Echo of the requested 0x address.
  address: string;
  /// Echo of the requested asset id.
  asset_id: number;
  /// Effective leverage (position, else account default, else market max).
  leverage: number;
  /// Effective margin mode.
  margin_mode: 'cross' | 'isolated' | 'strict_iso';
  /// Per-asset max-order ceiling (size units), decimal string.
  max_trade_size: string;
  /// Whether the user has a non-zero position on this asset.
  has_position: boolean;
}

/// One per-asset max market-order notional entry.
export interface MaxMarketOrderNtl {
  /// Asset id.
  asset_id: number;
  /// OI-cap-derived size ceiling, decimal string.
  max_market_order_ntl: string;
}

/// `max_market_order_ntls` — per-asset max market-order notional.
export interface MaxMarketOrderNtls {
  /// Per-asset ceilings.
  ntls: MaxMarketOrderNtl[];
}

/// One vault summary row (shared by `vault_summaries` / `leading_vaults`).
export interface VaultSummary {
  /// Vault id.
  id: number;
  /// Vault on-chain address (0x).
  address: string;
  /// Vault leader address (0x).
  leader: string;
  /// NAV proxy (high-water mark, USD cents), decimal string.
  tvl: string;
  /// Number of share holders.
  follower_count: number;
  /// Vault kind.
  kind: 'user' | 'metaliquidity';
}

/// `vault_summaries` — all vaults summary.
export interface VaultSummaries {
  /// Vault summary rows.
  vaults: VaultSummary[];
}

/// One vault equity entry inside `UserVaultEquities`.
export interface VaultEquity {
  /// Vault id.
  vault_id: number;
  /// Vault address (0x).
  vault_address: string;
  /// Caller's share count (18-dec), decimal string.
  shares: string;
  /// `shares × share_price`, decimal string (truncated).
  equity: string;
}

/// `user_vault_equities` — vaults a user has deposited into + share / equity.
export interface UserVaultEquities {
  /// Echo of the requested 0x address.
  address: string;
  /// Per-vault equities.
  equities: VaultEquity[];
}

/// `leading_vaults` — vaults led by the user (reuses `VaultSummary` rows).
export interface LeadingVaults {
  /// Echo of the requested 0x address.
  address: string;
  /// Vault summary rows led by the user.
  vaults: VaultSummary[];
}

/// `user_rate_limit` — a user's action stats / rate-limit budget.
export interface UserRateLimit {
  /// Echo of the requested 0x address.
  address: string;
  /// Last accepted action nonce.
  last_nonce: number;
  /// Pending (in-flight) action count.
  pending_count: number;
  /// Lifetime actions submitted.
  lifetime_count: number;
}

/// `spot_deploy_state` — MIP-1 spot-pair-deploy gas-auction state.
export interface SpotDeployState {
  /// Current round.
  auction_round: number;
  /// Leading bid, decimal string.
  current_bid: string;
  /// Current high bidder (0x), or `null`.
  current_winner: string | null;
  /// Auction close timestamp (consensus ms).
  auction_end_ms: number;
  /// Auction start timestamp (consensus ms).
  started_at_ms: number;
  /// Cumulative burned winning-bid notional, decimal string.
  total_burned: string;
  /// Total escrowed deposit (base units), decimal string.
  deposit: string;
}

/// `delegator_summary` — staking summary for an address.
export interface DelegatorSummary {
  /// Echo of the requested 0x address.
  address: string;
  /// Sum of active delegations, decimal string.
  total_delegated: string;
  /// Sum of pending undelegations, decimal string.
  pending_withdrawal: string;
  /// Accumulated delegator rewards, decimal string.
  claimable_rewards: string;
  /// Number of active delegations.
  n_delegations: number;
}

/// `max_builder_fee` — approved builder-fee ceiling for `(address, builder)`.
export interface MaxBuilderFee {
  /// Echo of the requested 0x address.
  address: string;
  /// Echo of the requested builder 0x address.
  builder: string;
  /// Approved bps ceiling; `0` if not approved.
  max_fee_bps: number;
  /// Whether `(address, builder)` is an approved pair.
  approved: boolean;
}

/// `user_to_multi_sig_signers` — multisig config for an address.
export interface UserToMultiSigSigners {
  /// Echo of the requested 0x address.
  address: string;
  /// Whether the account is multisig.
  is_multi_sig: boolean;
  /// M-of-N threshold; `0` if not multisig.
  threshold: number;
  /// Signer set (0x addresses); empty if not multisig.
  signers: string[];
}

/// `user_role` — derived account role.
export interface UserRole {
  /// Echo of the requested 0x address.
  address: string;
  /// Derived role.
  role: 'missing' | 'user' | 'agent' | 'vault' | 'sub_account';
}

/// `perps_at_open_interest_cap` — assets whose OI is at/over the cap.
export interface PerpsAtOpenInterestCap {
  /// Asset ids at/over their `oi_cap`, ascending.
  assets: number[];
}

/// One validator L1 vote.
export interface ValidatorL1Vote {
  /// Vote round.
  round: number;
  /// Casting validator address (0x).
  validator: string;
  /// Submission timestamp (consensus ms).
  submitted_at_ms: number;
}

/// `validator_l1_votes` — current validator L1 votes.
export interface ValidatorL1Votes {
  /// Latest accepted vote round.
  latest_round: number;
  /// Votes.
  votes: ValidatorL1Vote[];
}

/// One margin-tier row.
export interface MarginTier {
  /// Asset id.
  asset_id: number;
  /// Effective max leverage.
  max_leverage: number;
  /// Maintenance margin ratio, bps string.
  maint_margin_ratio: string;
  /// Initial margin ratio, bps string.
  init_margin_ratio: string;
}

/// `margin_table` — the margin-tier table (one effective tier per market).
export interface MarginTable {
  /// Per-market tiers.
  tiers: MarginTier[];
}

/// One perp DEX entry.
export interface PerpDex {
  /// DEX index in `Exchange.perp_dexs`.
  index: number;
  /// Number of asset books in the DEX.
  n_assets: number;
  /// Asset ids in the DEX.
  assets: number[];
}

/// `perp_dexs` — list the perp DEX(es).
export interface PerpDexs {
  /// Perp DEXes.
  dexs: PerpDex[];
}

/// One validator summary row.
export interface ValidatorSummary {
  /// Validator primary address (0x).
  validator: string;
  /// Operational signer / hot key (0x).
  signer: string;
  /// Consensus index.
  validator_index: number;
  /// Total delegated stake, decimal string.
  stake: string;
  /// Validator's own contribution, decimal string.
  self_stake: string;
  /// Commission (basis points).
  commission_bps: number;
  /// In the active set this epoch.
  is_active: boolean;
  /// Currently jailed.
  is_jailed: boolean;
  /// Jail start ts (consensus ms), or `null` if not jailed.
  jailed_at_ms: number | null;
  /// Earliest unjail ts (consensus ms), or `null` if not jailed.
  unjail_at_ms: number | null;
  /// First epoch the validator was active.
  first_active_epoch: number;
}

/// `validator_summaries` — per-validator snapshot.
export interface ValidatorSummaries {
  /// Current staking epoch.
  epoch: number;
  /// Σ stake across all validators, decimal string.
  total_stake: string;
  /// Size of the active set.
  n_active: number;
  /// Validator rows.
  validators: ValidatorSummary[];
}

/// `gossip_root_ips` — configured gossip root/seed peer endpoints.
export interface GossipRootIps {
  /// Configured gossip peer endpoints (`host:port`); empty on a solo node.
  root_ips: string[];
}

/// One position row inside `WebData2.clearinghouse`.
export interface WebData2Position {
  /// Asset id.
  asset: number;
  /// Signed position size, decimal string.
  size: string;
  /// Entry notional, decimal string.
  entry_notional: string;
  /// Effective margin mode.
  margin_mode: 'cross' | 'isolated' | 'strict_iso';
  /// Per-asset leverage multiple.
  leverage: number;
}

/// The clearinghouse summary inside `WebData2`.
export interface WebData2Clearinghouse {
  /// Cross account value, decimal string.
  account_value: string;
  /// Σ per-asset margin used, decimal string.
  margin_used: string;
  /// Per-asset open positions.
  positions: WebData2Position[];
}

/// `web_data2` — composite "everything for the frontend" snapshot.
export interface WebData2 {
  /// Echo of the requested 0x address.
  address: string;
  /// Perp clearinghouse summary.
  clearinghouse: WebData2Clearinghouse;
  /// Spot balances (reuses `spot_clearinghouse_state.balances`).
  spot_balances: SpotBalance[];
  /// Open orders (reuses `frontend_open_orders.orders`).
  open_orders: FrontendOpenOrder[];
  /// Vault equities (reuses `user_vault_equities.equities`).
  vault_equities: VaultEquity[];
  /// Global exchange status (reuses `exchange_status.data`).
  exchange_status: ExchangeStatus;
}
