// Core response interfaces for the MTF-native `POST /info` read surface.
//
// Source of truth (read these, do not guess): the KB spec
// metaflux-knowledges/api/rest/info.md. Every field name here is the EXACT
// snake_case key the node emits inside the `{type, data}` envelope's `data`
// object (the envelope itself is unwrapped by `InfoApi`).
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
