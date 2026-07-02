// Node-snapshot / parity response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md. Field
// names are the exact snake_case keys the node emits inside `{type, data}.data`.
// Money magnitudes that can exceed 2^53 are typed `string`.

import type { MarketInfo } from './core.js';

/// One spot pair inside `SpotMeta` (also `markets.spot.pairs`).
export interface SpotPair {
  /// Numeric pair id — also the compact `coin` label spot prints carry on the
  /// WS `trades` / `candles` / `fills` channels.
  id: number;
  /// Display name derived as `{base}/{quote}` from the token registry
  /// (e.g. `"BTC/USDC"`).
  name: string;
  /// Base asset id.
  base: number;
  /// Quote asset id.
  quote: number;
  /// Taker fee, decimal bps string; `"0"` if unset.
  taker_fee_bps: string;
  /// Min notional (USDC cents), decimal string; `"0"` if unset.
  min_notional: string;
  /// Whether the pair is active for trading.
  active: boolean;
  /// Pair mark price, decimal string.
  mark_px: string;
  /// Order-book mid price, decimal string; `null` when one-sided.
  mid_px: string | null;
  /// Previous-day close price, decimal string; `null` if unset.
  prev_day_px: string | null;
  /// 24h notional (USD) volume, decimal string.
  day_ntl_vlm: string;
  /// Circulating base-token supply, decimal string.
  circulating_supply: string;
}

/// One token registry entry inside `SpotMeta` (also `markets.spot.tokens`).
export interface SpotToken {
  /// Token asset id.
  id: number;
  /// Human token name (e.g. `"BTC"`).
  name: string;
  /// Display / size precision (decimals shown on the spot book).
  sz_decimals: number;
  /// Native (ERC-20-style) token decimals (e.g. USDC = 6, BTC = 8).
  wei_decimals: number;
  /// `0x` EVM contract bound to the token, or `null` when it has no binding.
  evm_contract: string | null;
  /// Whether the token is a canonical (genesis-seeded) listing.
  is_canonical: boolean;
  /// Token system address (0x).
  system_address: string;
  /// Deterministic token id hash (`0x` + 32 bytes).
  token_id: string;
}

/// `spot_meta` — spot pair universe + token registry. The same object is
/// embedded as `markets.spot`.
export interface SpotMeta {
  /// Registered spot pairs (token-registration sentinels excluded).
  pairs: SpotPair[];
  /// Token registry with per-token decimals.
  tokens: SpotToken[];
}

/// `markets` — the full market universe: every perp market plus the spot
/// pair/token registry, in one read.
export interface Markets {
  /// Registered perp markets.
  perp: MarketInfo[];
  /// Spot universe (same object as the `spot_meta` read).
  spot: SpotMeta;
}

/// One spot balance inside `SpotClearinghouseState` (and the WS `spot_state`
/// stream).
export interface SpotBalance {
  /// Spot asset id.
  asset: number;
  /// Token symbol, else `asset:<id>`.
  name: string;
  /// Total balance (spendable + hold), whole-token decimal string.
  total: string;
  /// Amount reserved by resting spot orders, whole-token decimal string.
  hold: string;
}

/// `spot_clearinghouse_state` — per-account spot token balances. With
/// `account_state` this replaces the removed `web_data2` composite.
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
  /// Whether the chain is currently upgrade-frozen.
  frozen: boolean;
  /// Whether startup replay has completed (reads are live).
  replay_complete: boolean;
}

/// A trigger detail attached to a `FrontendOpenOrder`.
export interface OrderTrigger {
  /// Trigger price, canonical decimal string (whole-USDC, tick-snapped).
  trigger_px: string;
  /// Whether the trigger fires above (`true`) or below the price.
  trigger_above: boolean;
  /// `true` on a parked (off-book) TP/SL / stop row. Absent on the trigger
  /// block of a resting book order.
  is_parked?: boolean;
}

/// One order inside `FrontendOpenOrders` — `open_orders` plus frontend detail.
/// Parked TP/SL / stop triggers are surfaced too, with `tif: "trigger"` and a
/// populated `trigger` block.
export interface FrontendOpenOrder {
  /// On-chain order id.
  oid: number;
  /// Market symbol (e.g. `"BTC"`).
  coin: string;
  /// Order side.
  side: 'bid' | 'ask';
  /// Resting price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Remaining size, canonical decimal string (whole units).
  size: string;
  /// Time-in-force; `"trigger"` for an off-book parked stop.
  tif: 'alo' | 'ioc' | 'gtc' | 'trigger';
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

/// `active_asset_data` — a user's per-asset leverage / margin-mode / tradeable
/// size, keyed by `(address, coin)`. The WS `active_asset_ctx` sibling carries
/// market-wide context; this read is account-scoped.
///
/// The `[buy, sell]` pairs: `available_to_trade` is the per-side NOTIONAL
/// still openable given free collateral × leverage (whole-USDC), and
/// `max_trade_szs` the same budget converted to base-unit SIZE at the mark.
export interface ActiveAssetData {
  /// Echo of the requested 0x address.
  address: string;
  /// Echo of the requested market symbol.
  coin: string;
  /// Effective leverage (per-asset setting, else market max).
  leverage: number;
  /// Effective margin mode.
  margin_mode: 'cross' | 'isolated' | 'strict_iso';
  /// Mark price used for the size conversion, whole-USDC decimal string.
  mark_px: string;
  /// `[buy, sell]` notional still openable, whole-USDC decimal strings.
  available_to_trade: [string, string];
  /// `[buy, sell]` max order size, base-unit decimal strings.
  max_trade_szs: [string, string];
  /// OI-cap-derived market-order ceiling, decimal string.
  max_trade_size: string;
  /// Whether the user has a non-zero position on this asset.
  has_position: boolean;
}

/// One per-asset max market-order notional entry.
export interface MaxMarketOrderNtl {
  /// Market symbol.
  coin: string;
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
  /// Vault display name.
  name: string;
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
  /// Market symbols at/over their OI cap.
  assets: string[];
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

/// One perp DEX entry.
export interface PerpDex {
  /// DEX index in the exchange's perp-dex list.
  index: number;
  /// Number of asset books in the DEX.
  n_assets: number;
  /// Market symbols in the DEX.
  assets: string[];
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
  /// Commission, decimal bps string.
  commission_bps: string;
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
