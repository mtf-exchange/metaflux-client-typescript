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
///
/// The size key here is `size`, NOT the `sz` that order / book / trade rows
/// carry. The two size keys are deliberately different: a position size is
/// signed, an order size is not.
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
  /// Liquidation price, or `null` when the position has none — an isolated leg
  /// whose bucket no non-negative price can breach reads `null`, NEVER `"0"`. A
  /// zero is a price; an absence is not, and reading one as the other says
  /// "liquidates immediately" about a position that cannot be price-liquidated.
  liq: string | null;
  /// Return on equity, decimal fraction string (signed).
  roe: string;
  /// Cumulative funding paid/received on the position, whole-USDC (signed).
  funding: string;
  /// Margin used by the position, whole-USDC decimal string.
  margin: string;
  /// Maintenance margin this leg requires, whole-USDC decimal string.
  maint_margin: string;
  /// Position notional value, whole-USDC decimal string.
  notional: string;
  /// Hedge-mode leg label (`"long"` / `"short"`). Absent on a one-way account's
  /// net position (whose `size` sign carries the direction).
  ///
  /// This `side` is a LEG LABEL. It is not the `"B"` / `"A"` side token that
  /// order, book, and trade rows carry.
  side?: 'long' | 'short';
}

/// The positions of one perp dex inside `AccountState.clearinghouse_state`.
/// The object wraps `positions` so the node can add per-dex fields later.
export interface DexPositions {
  /// Open positions on that dex.
  positions: AccountPosition[];
}

/// One token balance row. The shape is shared by `account_state.balances` and
/// `spot_clearinghouse_state.balances`.
export interface TokenBalance {
  /// Token asset id.
  asset: number;
  /// Token symbol (e.g. `"USDC"`).
  name: string;
  /// Total balance (spendable + hold), whole-token decimal string.
  total: string;
  /// Amount reserved by resting spot orders, whole-token decimal string.
  hold: string;
}

/// `account_state` — rich per-account snapshot keyed by `address`.
///
/// Margin scalars are whole-USDC decimal strings. This read (with
/// `spot_clearinghouse_state`) replaces the removed `web_data2` composite.
export interface AccountState {
  /// Echo of the requested 0x address.
  address: string;
  /// Equity including unrealised PnL, whole-USDC decimal string.
  account_value: string;
  /// Cash the account can take out, decimal string, CLAMPED at zero.
  ///
  /// It is settled cash minus funding owed minus `init_margin`. It does NOT
  /// count unrealised profit, so a healthy account whose margin is funded by
  /// open profit reads `'0'` — that means "nothing to withdraw", not "broke".
  /// The chain's admission gate uses the raw signed figure, which can go
  /// negative; this read never does.
  withdrawable: string;
  /// Initial margin requirement, decimal string.
  init_margin: string;
  /// `account_value - maint_margin` (signed decimal string). Read the
  /// maintenance margin itself from the `margin_summary` read.
  health: string;
  /// Liquidation tier.
  tier: Tier;
  /// Present and `true` ONLY when the risk engine DEFERS on this account: it
  /// holds a leg no risk path can price. The reported maintenance margin is
  /// then `0` for want of a price, NOT because the account carries no
  /// requirement — so `tier` and `health` are not solvency statements. A
  /// priceable account omits the key. The market-side twin is `px_stale`.
  health_deferred?: boolean;
  /// Margin abstraction class (`abstraction === 'portfolio'` = PM enrolled).
  abstraction: Abstraction;
  /// Open positions grouped by perp dex. The core dex key is the empty string
  /// `""` and is always present; a MIP-3 deployer dex key is the deployer's
  /// lowercase 0x address.
  clearinghouse_state: Record<string, DexPositions>;
  /// Token balances. The USDC row is always first; an all-zero token row is
  /// skipped.
  balances: TokenBalance[];
  /// Portfolio-margin maintenance requirement, whole-USDC decimal string.
  /// Always present — `"0"` when the account is not PM-enrolled. Gate the
  /// meaning on `abstraction === 'portfolio'`.
  pm_maint_margin: string;
  /// Portfolio-margin net account value, whole-USDC decimal string. Same
  /// presence rule as `pm_maint_margin`.
  pm_net_value: string;
  /// Portfolio-margin concentration penalty, whole-USDC decimal string. Same
  /// presence rule as `pm_maint_margin`.
  pm_concentration_penalty: string;
  /// Position mode: `"one_way"` (single net position) or `"hedge"` (two-way).
  position_mode: 'one_way' | 'hedge';
  /// Committed block height of the snapshot. Compare it across two reads to
  /// reject a stale snapshot.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
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

/// An EVM contract binding on a registered token. Emitted as an OBJECT on the
/// spot token registry and on a perp market's underlying-`token` block — NOT a
/// bare `0x` string. `null`/omitted when the token has no EVM binding.
export interface TokenEvmContract {
  /// `0x` EVM contract address bound to the token.
  address: string;
  /// Extra wei-decimals offset applied on the EVM side relative to the token's
  /// native `wei_decimals` (signed; `0` = no offset).
  evm_extra_wei_decimals: number;
}

/// The registered underlying token of a perp market, surfaced inline on a
/// `MarketInfo` (`markets_meta` / `market_info` perp rows) as the `token`
/// block. OMITTED (absent, never `null`) when the perp has no registered
/// underlying token. Note the issuance field is `circulating_supply` here,
/// whereas a spot token registry row (`SpotToken`) carries `total_supply` —
/// the two key names are NOT interchangeable.
export interface PerpUnderlyingToken {
  /// Underlying token asset id.
  id: number;
  /// Native (ERC-20-style) token decimals.
  wei_decimals: number;
  /// Deterministic token id hash (`0x` + 32 bytes).
  token_id: string;
  /// Token system address (`0x`).
  system_address: string;
  /// EVM contract binding, or `null` when the token has no binding.
  evm_contract: TokenEvmContract | null;
  /// Whether the token is a canonical (genesis-seeded) listing.
  is_canonical: boolean;
  /// Circulating supply of the underlying, decimal string.
  circulating_supply: string;
}

/// The STATIC half of a market — the `markets_meta` perp row.
///
/// Long-cacheable: precision grids, the leverage ladder, the trade-control
/// flags and the join keys. It carries NO live price, funding or open interest;
/// read `Markets.perp` for those and merge by `coin`.
///
/// `sz_decimals` is load-bearing for size encoding — raw order/position `size`
/// = `whole_units × 10^sz_decimals`, NOT derivable from `step_size`.
export interface MarketStatic {
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
  /// Mark-price source descriptor (e.g. `"oracle_median"`).
  mark_source: string;
  /// Whether frequent-batch-auction matching is enabled for this market.
  fba_enabled: boolean;
  /// Whether opening a position is PERMITTED.
  ///
  /// Replaces `disable_open`, and the meaning is INVERTED: `open: true` allows
  /// opening, where `disable_open: true` blocked it. Read the new name; a
  /// leftover `disable_open` on a market row is `undefined`, which is falsy,
  /// so the old test silently reports "allowed" for a market that is closed.
  open: boolean;
  /// Whether closing a position is PERMITTED. Replaces `disable_close`, with
  /// the same inversion.
  close: boolean;
  /// Whether the market is strict-isolated-only.
  strict_isolated: boolean;
  /// Governance open-interest cap, whole base units as a decimal string.
  /// OMITTED (absent) when the market is uncapped — an absent cap is not a cap
  /// of `0`, so test for the key, not for a falsy value.
  oi_cap?: string;
  /// The registered underlying token block, when the perp has one. OMITTED
  /// (absent) when there is no registered underlying token — never `null`.
  token?: PerpUnderlyingToken;
}

/// The DYNAMIC half of a market — the `markets` perp row.
///
/// Live price, funding, open interest and the 24h ticker. It carries NO
/// precision grid, NO leverage ladder and NO trade-control flag: reading
/// `sz_decimals`, `tick_size`, `open` or `close` off this row yields
/// `undefined`. Read `MarketsMeta.perp` for those and merge by `coin`, or read
/// `market_info` for the union on one market.
export interface MarketDynamic {
  /// Market symbol (e.g. `"BTC"`) — the join key onto `MarketStatic`.
  coin: string;
  /// Market kind — lowercase `"perp"` / `"spot"`.
  kind: MarketKind;
  /// Mark price, whole-USDC decimal string (tick-snapped; `"0"` fallback).
  mark_px: string;
  /// Oracle/index price, whole-USDC decimal string (`"0"` fallback).
  oracle_px: string;
  /// Present and `true` ONLY when the oracle index is stale. The market still
  /// advertises a `mark_px`, but no aggregation pass sourced it and every risk
  /// path defers on it. A healthy market OMITS the key.
  px_stale?: boolean;
  /// Order-book mid price, whole-USDC decimal string. OMITTED (absent) when the
  /// book is one-sided — the key is dropped, never sent as `null`.
  mid_px?: string;
  /// `[bid, ask]` impact prices. OMITTED (absent) when the impact notional
  /// cannot fill against the current book.
  impact_pxs?: [string, string];
  /// Mark-vs-oracle premium, signed decimal fraction string; `null` when no
  /// premium is computable.
  premium: string | null;
  /// Funding parameters.
  funding: Funding;
  /// Open interest, whole units as a decimal string.
  open_interest: string;
  /// 24h notional (USD) volume, decimal string.
  day_ntl_vlm: string;
  /// Oldest consensus ms that `day_ntl_vlm` speaks for. Present ⇒ the volume is
  /// a LOWER BOUND because the trade tape cannot cover the whole window; ABSENT
  /// ⇒ the figure covers the full 24h.
  day_ntl_vlm_lower_bound_from?: number;
  /// Previous-day close price, whole-USDC decimal string; `null` when no
  /// 24h-ago snapshot carries a price.
  prev_day_px: string | null;
  /// 24h price change, signed decimal fraction string; `null` when there is no
  /// 24h-ago price to compare against.
  change_24h: string | null;
  /// Whether the market is halted.
  halted: boolean;
}

/// `market_info` — the UNION of both halves for one market.
///
/// Only this read serves every field. `markets` serves `MarketDynamic` and
/// `markets_meta` serves `MarketStatic`; neither serves the other's fields.
export interface MarketInfo extends MarketStatic, MarketDynamic {}

/// `vault_state` — per-vault snapshot keyed by vault `address`.
export interface VaultState {
  /// Vault on-chain address (0x).
  vault: string;
  /// Vault display name.
  name: string;
  /// TVL = high-water-mark NAV proxy, WHOLE-USDC decimal string.
  tvl: string;
  /// Share price = NAV / total shares, WHOLE USDC per WHOLE share, full
  /// precision. The node already applies the share scale, so a client that
  /// multiplies by `1e18` reads the price 1e18 times too high.
  share_price: string;
  /// Distinct depositor count.
  depositor_count: number;
  /// High-water mark, WHOLE-USDC decimal string.
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
  /// DELEGATED stake only, decimal string — the sum of `delegations[*].amount`.
  /// It is not the account's whole staked balance: add
  /// `undelegated_pool_balance`.
  total_staked: string;
  /// Stake deposited but NOT delegated, decimal string on the same plane as
  /// `total_staked`. `stakingDeposit` credits this pool and `stakingWithdraw`
  /// debits it, so stake can rest here undelegated for as long as the holder
  /// likes, and a caller reading only `total_staked` reports less than the
  /// account holds. This is not `pending_unstakes`: the free pool is already
  /// free, while a pending unstake is locked until `matures_at_ts`.
  ///
  /// Optional because a node that predates the field omits it. Treat an absent
  /// value as unknown, never as a zero balance.
  undelegated_pool_balance?: string;
  /// Active per-validator delegations.
  delegations: Delegation[];
  /// Pending unbond entries.
  pending_unstakes: PendingUnstake[];
}

/// A per-asset row inside `ProtocolMetrics`. Rows arrive as an ARRAY in
/// ascending `asset`, not as an object, because a JSON object gives no ordering
/// guarantee across clients and these rows must stay ordered.
export interface AssetAmount {
  /// Asset id.
  asset: number;
  /// The amount for this asset, decimal string.
  amount: string;
}

/// A per-asset signed-position-sum row inside `ProtocolMetrics`.
export interface AssetSignedSum {
  /// Asset id.
  asset: number;
  /// Sum of `size_signed` over every position row on this market, as a signed
  /// decimal string on the market's own raw committed lot plane.
  sum_signed: string;
}

/// Native MTF held on the EVM side, inside `ProtocolMetrics`. This mirrors the
/// Core view only; the authoritative EVM state root is separate.
export interface ProtocolMetricsEvm {
  /// Total native balance in WEI, decimal string.
  native_balance_wei: string;
  /// EVM accounts holding a non-zero native balance.
  n_nonzero_holders: number;
  /// EVM accounts with any committed state.
  n_accounts: number;
}

/// `protocol_metrics` — protocol-wide committed accumulators.
///
/// Only the fields this SDK types are listed. The read serves more, so treat
/// this as a partial view and read unlisted keys off the raw payload.
export interface ProtocolMetrics {
  /// Native-MTF-on-EVM mirror.
  evm?: ProtocolMetricsEvm;
  /// Per-market open interest as a WHOLE-UNIT size string on that market's own
  /// size plane, ascending `asset`.
  ///
  /// There is deliberately no cross-market total. Each market keeps its own
  /// `sz_decimals` lot plane, so summing raw lots across markets adds
  /// quantities with no common unit — which is what the removed
  /// `open_interest_total_1e8` did. To get a protocol-wide figure, convert each
  /// market to notional first.
  ///
  /// Optional because a node that predates the field omits it, and answers the
  /// removed total instead.
  open_interest_by_asset?: AssetAmount[];
  /// Per market, the sum of `size_signed` over EVERY position row.
  ///
  /// Every long leg has a short leg, so the honest value is `"0"` on each
  /// asset. A non-zero entry marks a committed one-sided write to a position
  /// row, which the open-interest figure cannot show.
  position_size_signed_sum_by_asset?: AssetSignedSum[];
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

/// The `params` block on a `SpotMarginAccount` — the pair's risk parameters.
/// `null` on the account when margin is disabled / uncalibrated for the pair.
///
/// Both bps fields are JSON STRINGS of integers. Other bps fields on this
/// surface (`performance_fee_bps`) are raw numbers, so do not normalize.
export interface SpotMarginParams {
  /// Initial-margin requirement, bps as a decimal string.
  init_bps: string;
  /// Maintenance-margin requirement, bps as a decimal string.
  maint_bps: string;
}

/// One spot-margin position inside a `SpotMarginState`. All magnitudes are
/// full-precision normalized decimal strings (fractional planes — borrow
/// indices, sub-unit base sizes — that whole-unit truncation would destroy).
export interface SpotMarginAccount {
  /// Spot pair NAME (e.g. `"BTC/USDC"`) — the same symbol the market reads use.
  pair: string;
  /// Posted collateral, decimal string.
  collateral: string;
  /// Borrowed principal, decimal string.
  borrowed: string;
  /// Borrow-index snapshot at the last accrual, decimal string.
  borrow_index_snapshot: string;
  /// Base asset held in the position, decimal string.
  base_held: string;
  /// Current accrued debt = `borrowed × (pool.borrow_index / snapshot)`,
  /// decimal string.
  current_debt: string;
  /// Pair risk parameters, or `null` when margin is disabled / uncalibrated.
  params: SpotMarginParams | null;
}

/// `spot_margin_state` — every spot-margin position of one user.
///
/// REQUEST KEY is `user` (0x hex), NOT `address` — the node's spot-margin read
/// surface keys by `user`.
export interface SpotMarginState {
  /// Echoed user address (0x).
  user: string;
  /// Spot-margin positions, in deterministic pair-id order.
  accounts: SpotMarginAccount[];
}

/// One Earn lending pool inside an `EarnState`. `user_shares` / `user_value`
/// appear ONLY when the request carried a `user`. All magnitudes are
/// full-precision normalized decimal strings.
export interface EarnPool {
  /// Pool asset (token) id.
  asset: number;
  /// Token symbol beside the numeric `asset` — the same `{asset, name}` token
  /// row `account_state.balances` carries.
  name: string;
  /// Total supplied principal, decimal string.
  total_supplied: string;
  /// Total borrowed principal, decimal string.
  total_borrowed: string;
  /// Idle liquidity = `total_supplied − total_borrowed`, decimal string.
  idle: string;
  /// Total outstanding shares, decimal string.
  shares_total: string;
  /// NAV per share = `total_supplied / shares_total` (`"0"` when no shares),
  /// decimal string.
  share_value: string;
  /// Current borrow index, decimal string.
  borrow_index: string;
  /// Reserve factor, bps as a decimal string.
  reserve_factor_bps: string;
  /// Annualized borrow rate, bps as a decimal string.
  borrow_rate_bps_annual: string;
  /// Accrued protocol reserve, decimal string.
  reserve_accrued: string;
  /// The user's share balance, decimal string. Present only when `user` was
  /// sent (zero string for a non-supplier).
  user_shares?: string;
  /// The user's stake value = `user_shares × share_value`, decimal string.
  /// Present only when `user` was sent.
  user_value?: string;
}

/// `earn_state` — every Earn lending pool, plus one user's stake when the
/// optional `user` (0x hex) is sent.
export interface EarnState {
  /// Pools, in committed order.
  pools: EarnPool[];
}

/// `pm_summary` — one account's portfolio-margin summary.
///
/// REQUEST KEY is `address` (0x hex); an `account_id` is rejected. An unknown /
/// non-enrolled address answers 200 with `enrolled:false` and zeroed figures.
///
/// PLANE: the three money figures are WHOLE-USDC decimal strings — the same
/// plane, and now the same names, as the `account_state` twins. They were once
/// USD-cents integers called `pm_maint_margin_cents` / `net_value_cents` /
/// `concentration_penalty_cents`; the node serves NEITHER those names NOR that
/// plane. The rename carried a 100x plane change with it, so a caller still
/// reading an old name gets `undefined`, not a number that is merely stale.
export interface PmSummary {
  /// Resolved account address (0x).
  address: string;
  /// Whether the account is enrolled in portfolio margin.
  enrolled: boolean;
  /// Enrollment timestamp (consensus ms); `0` when not enrolled.
  enrolled_at: number;
  /// Block height of the last PM computation; `0` when not enrolled.
  last_computed_block: number;
  /// Maintenance-margin requirement, WHOLE-USDC decimal string.
  pm_maint_margin: string;
  /// Net account value, WHOLE-USDC decimal string.
  pm_net_value: string;
  /// Concentration penalty, WHOLE-USDC decimal string.
  pm_concentration_penalty: string;
}

/// `encode_action` — the canonical core `Action` JSON for a wire action.
///
/// SDK-critical for `multi_sig`: the returned STRING's exact bytes are the
/// `inner_action_blob` every M-of-N member signs. The node lowers the wire
/// action via the SAME `into_action` path admission uses, so the bytes a member
/// signs match the bytes the `multi_sig` handler verifies and executes.
export interface EncodeAction {
  /// The canonical externally-tagged core `Action` JSON string (the blob).
  action_json: string;
}
