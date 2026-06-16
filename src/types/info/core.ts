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
  entry: string;
  /// Unrealised PnL (signed), decimal string (same unit as `account_value`).
  upnl: string;
  /// Whether this position uses isolated margin.
  isolated: boolean;
  /// Per-asset leverage multiple.
  lev: number;
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
  mode: MarginMode;
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

/// Market kind. The deployed gateway emits lowercase `"perp"` / `"spot"`.
export type MarketKind = 'perp' | 'spot';

/// `market_info` / `markets` element — rich per-market metadata.
///
/// `mark_px` and `oracle_px` are whole-USDC decimal strings (tick-snapped;
/// `"0"` fallback). `sz_decimals` is load-bearing for size encoding — raw
/// order/position `size` = `whole_units × 10^sz_decimals`, NOT derivable from
/// `step_size`.
export interface MarketInfo {
  /// Canonical asset id.
  asset_id: number;
  /// Human-readable market name (e.g. `"BTC"`).
  name: string;
  /// Market kind — lowercase `"perp"` / `"spot"`.
  kind: MarketKind;
  /// Size precision: raw order/position `size` = `whole_units × 10^sz_decimals`.
  /// Load-bearing for size encoding — NOT derivable from `step_size`.
  sz_decimals: number;
  /// Mark price, whole-USDC plane as a decimal string (`"0"` fallback).
  mark_px: string;
  /// Oracle/index price, whole-USDC plane as a decimal string (`"0"` fallback).
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
/// `burn_ratio` is a decimal fraction string in `[0, 1]` (`"0.8"` = 80%) — NOT
/// bps, do not scale it by 10000. `tiers[0]` is the authoritative carrier of
/// maker/taker when the top-level pair is absent.
export interface FeeSchedule {
  /// Top-level base maker fee, decimal bps string. Present on the deployed
  /// gateway; ABSENT from a node built from current source — fall back to
  /// `tiers[0].maker_bps` when `undefined`.
  maker_bps?: string;
  /// Top-level base taker fee, decimal bps string. See `maker_bps`.
  taker_bps?: string;
  /// Volume-tier ladder (authoritative carrier of maker/taker).
  tiers: FeeTier[];
  /// Max additional builder-code rebate, decimal bps string.
  builder_rebate_bps: string;
  /// Burn fraction of the non-referrer remainder, decimal fraction string in
  /// `[0, 1]` (NOT bps).
  burn_ratio: string;
  /// Referrer share of the base taker take, decimal bps string.
  referrer_share_bps: string;
}
