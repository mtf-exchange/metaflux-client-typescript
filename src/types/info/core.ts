// Core response interfaces for the MTF-native `POST /info` read surface.
//
// Source of truth (read these, do not guess): the KB spec
// metaflux-knowledges/api/rest/info.md. Every field name here is the EXACT
// snake_case key the node emits inside the `{type, data}` envelope's `data`
// object (the envelope itself is unwrapped by `InfoApi`).
//
// KEYING (consolidated surface): market-scoped reads are keyed by `coin` —
// the market SYMBOL string (e.g. `"BTC"`) — and account-scoped reads by
// `address` (0x hex). The old numeric `market_id` / `asset_id` / `account_id`
// request params are gone; responses render `coin` symbols.
//
// Money-magnitude convention: any value that can exceed JS
// `Number.MAX_SAFE_INTEGER` (2^53) — u128 / i128 / decimal magnitudes — is
// typed `string` to match the node's decimal-string encoding and avoid silent
// precision loss. Ids / counts / leverage that the node emits as JSON numbers
// within safe range stay `number`. Optional fields the node only emits
// conditionally are `?`.

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
  /// Node software version string. Additive; may be absent on older nodes.
  version?: string;
  /// Whether the node supports the freeze-halt upgrade protocol. Additive.
  freeze_halt_supported?: boolean;
}

/// Account liquidation tier — see `concepts/tiered-liquidation.md`.
export type Tier = 'Safe' | 'T0' | 'T1' | 'T2' | 'T3';

/// Per-position / per-asset margin mode label (lowercase wire form).
export type MarginMode = 'cross' | 'isolated' | 'strict_iso';

/// Account margin abstraction class: `"unified"` (default cross-collateral
/// account) or `"portfolio"` (portfolio-margin enrolled). Replaces the old
/// account-level `pm_enabled` boolean — derive PM enrollment as
/// `abstraction === 'portfolio'`.
export type Abstraction = 'unified' | 'portfolio';

/// One open position inside an `AccountState`.
///
/// All USD magnitudes are whole-USDC decimal strings. `size` is the signed
/// REAL size (whole units, sign preserved for shorts).
export interface AccountPosition {
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Signed position size, whole units as a decimal string.
  size: string;
  /// Volume-weighted entry price, whole-USDC decimal string.
  entry: string;
  /// Unrealised PnL (signed), whole-USDC decimal string.
  upnl: string;
  /// Whether this position uses isolated margin.
  isolated: boolean;
  /// The user's chosen leverage for the asset (never `0` for an open position).
  lev: number;
  /// Estimated liquidation price, whole-USDC decimal string (`"0"` = none).
  liq: string;
  /// Return on equity, decimal fraction string (signed).
  roe: string;
  /// Cumulative funding paid/received on the position, whole-USDC (signed).
  funding: string;
  /// Margin used by the position, whole-USDC decimal string.
  margin: string;
  /// Position notional value, whole-USDC decimal string.
  notional: string;
  /// Hedge-mode leg label (`"long"` / `"short"`). Absent on a one-way account's
  /// net position (whose `size` sign carries the direction).
  side?: 'long' | 'short';
}

/// One spot holding inside `Balances.spot`, keyed by token symbol.
export interface SpotHolding {
  /// The token's real SPOT asset id — use this for transfers (the perp
  /// markets table is a different id space).
  asset_id: number;
  /// Total balance (spendable + hold), whole-token decimal string.
  total: string;
  /// Amount reserved by resting spot orders, whole-token decimal string.
  hold: string;
  /// Whole-USDC mark value of the holding, or `null` when no spot price exists.
  value: string | null;
  /// `0x` EVM contract bound to the token, or `null` when it has no binding.
  evm_contract: string | null;
  /// Unrealized spot PnL vs recorded cost basis, whole-USDC (signed), or
  /// `null` when no cost basis is recorded.
  pnl: string | null;
}

/// Per-account balances inside an `AccountState`.
export interface Balances {
  /// USDC collateral (cross account value), whole-USDC decimal string.
  usdc: string;
  /// USDC's canonical EVM contract address (`0x` hex).
  usdc_evm_contract: string;
  /// Spot holdings keyed by token symbol.
  spot: Record<string, SpotHolding>;
}

/// `account_state` — rich per-account snapshot keyed by `address`.
///
/// Margin scalars are whole-USDC decimal strings. This read (with
/// `spot_state` / `spot_clearinghouse_state`) replaces the removed
/// `web_data2` composite.
export interface AccountState {
  /// Echo of the requested 0x address.
  address: string;
  /// Equity including unrealised PnL, whole-USDC decimal string.
  account_value: string;
  /// Equity minus initial margin held by open positions, decimal string.
  free_collateral: string;
  /// Maintenance margin requirement, decimal string.
  maint_margin: string;
  /// Initial margin requirement, decimal string.
  init_margin: string;
  /// `account_value - maint_margin` (signed decimal string).
  health: string;
  /// Liquidation tier.
  tier: Tier;
  /// Margin abstraction class (`abstraction === 'portfolio'` = PM enrolled).
  abstraction: Abstraction;
  /// Per-asset open positions.
  positions: AccountPosition[];
  /// Account balances.
  balances: Balances;
  /// Position mode: `"one_way"` (single net position) or `"hedge"` (two-way).
  position_mode: 'one_way' | 'hedge';
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

/// Market kind. The gateway emits lowercase `"perp"` / `"spot"`.
export type MarketKind = 'perp' | 'spot';

/// One margin-tier band inside `MarketInfo.margin_tiers`.
///
/// Bands are keyed by their UPPER open-interest bound: a position whose
/// notional open interest falls at or below `max_open_interest` gets that
/// band's `max_leverage` / `maint_margin_ratio`. The top band has
/// `max_open_interest: null` (unbounded).
export interface MarginTier {
  /// Upper OI bound for the band, whole-USDC decimal string; `null` on the
  /// unbounded top band.
  max_open_interest: string | null;
  /// Max leverage inside the band.
  max_leverage: number;
  /// Maintenance margin ratio inside the band, bps string.
  maint_margin_ratio: string;
}

/// `market_info` / `markets.perp[]` element — rich per-market metadata.
///
/// `mark_px` / `oracle_px` are whole-USDC decimal strings (tick-snapped;
/// `"0"` fallback). `sz_decimals` is load-bearing for size encoding — raw
/// order/position `size` = `whole_units × 10^sz_decimals`, NOT derivable from
/// `step_size`.
export interface MarketInfo {
  /// Market symbol (e.g. `"BTC"`) — the canonical market key on this surface.
  coin: string;
  /// @deprecated Numeric asset id shim. Do NOT build on this — key by `coin`.
  /// It remains only for the signed `/exchange` action plane (numeric `asset`
  /// stays u32 there) and may be dropped from this read without notice.
  asset_id: number;
  /// Market kind — lowercase `"perp"` / `"spot"`.
  kind: MarketKind;
  /// Size precision: raw order/position `size` = `whole_units × 10^sz_decimals`.
  /// Load-bearing for size encoding — NOT derivable from `step_size`.
  sz_decimals: number;
  /// Mark price, whole-USDC decimal string (`"0"` fallback).
  mark_px: string;
  /// Oracle/index price, whole-USDC decimal string (`"0"` fallback).
  oracle_px: string;
  /// Order-book mid price, whole-USDC decimal string; `null` when one-sided.
  mid_px: string | null;
  /// Previous-day close price, whole-USDC decimal string; `null` if unset.
  prev_day_px: string | null;
  /// 24h price change, decimal fraction string (signed).
  change_24h: string;
  /// 24h notional (USD) volume, decimal string.
  day_ntl_vlm: string;
  /// Mark-vs-oracle premium, decimal fraction string (signed).
  premium: string;
  /// Tick size (smallest price increment), decimal string.
  tick_size: string;
  /// Step size (smallest size increment / lot size), decimal string.
  step_size: string;
  /// Minimum order size, decimal string.
  min_order: string;
  /// Maximum leverage multiple (top margin-tier band).
  max_leverage: number;
  /// Effective maintenance margin ratio, bps string.
  maint_margin_ratio: string;
  /// Initial margin ratio, bps string.
  init_margin_ratio: string;
  /// OI-banded margin ladder (upper-bound bands; top band unbounded). Replaces
  /// the removed standalone `margin_table` query.
  margin_tiers: MarginTier[];
  /// Funding parameters.
  funding: Funding;
  /// Mark-price source descriptor (e.g. `"oracle_median"`).
  mark_source: string;
  /// Whether frequent-batch-auction matching is enabled for this market.
  fba_enabled: boolean;
  /// Open interest, whole units as a decimal string.
  open_interest: string;
  /// Whether opening new positions is disabled.
  disable_open: boolean;
  /// Whether closing positions is disabled.
  disable_close: boolean;
  /// Whether the market is halted.
  halted: boolean;
  /// Whether the market is strict-isolated-only.
  strict_isolated: boolean;
}

/// `vault_state` — per-vault snapshot keyed by vault `address`.
export interface VaultState {
  /// Vault on-chain address (0x).
  vault: string;
  /// Vault display name.
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
  /// Top-level base maker fee, decimal bps string. May be absent — fall back
  /// to `tiers[0].maker_bps` when `undefined`.
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
