// HL-node parity response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md (the
// hl_parity query shapes). Field names are the exact snake_case keys the node
// emits inside `{type, data}.data`. Money magnitudes that can exceed 2^53 are
// typed `string`.

/// One spot pair inside `SpotMeta`.
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
  /// Taker fee (bps); `0` if unset.
  taker_fee_bps: number;
  /// Min notional (USDC cents), decimal string; `"0"` if unset.
  min_notional: string;
  /// Whether the pair is active for trading.
  active: boolean;
}

/// One token registry entry inside `SpotMeta`.
export interface SpotToken {
  /// Token asset id.
  id: number;
  /// Human token name (e.g. `"BTC"`).
  name: string;
  /// Display / size precision (decimals shown on the spot book).
  sz_decimals: number;
  /// Native (ERC-20-style) token decimals (e.g. USDC = 6, BTC = 8).
  wei_decimals: number;
}

/// `spot_meta` — spot pair universe + token registry.
export interface SpotMeta {
  /// Registered spot pairs (token-registration sentinels excluded).
  pairs: SpotPair[];
  /// Token registry with per-token decimals.
  tokens: SpotToken[];
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

/// One perp asset context inside the HL-compat `meta_and_asset_ctxs` response —
/// the per-market price / volume / funding snapshot (camelCase HL field names,
/// all magnitudes decimal strings). Positional: the ctx at index `i` pairs with
/// the universe asset at index `i`.
export interface PerpAssetCtx {
  /// 24h notional (USD) volume, decimal string.
  dayNtlVlm: string;
  /// Previous-day close price, decimal string.
  prevDayPx: string;
  /// Current mark price, decimal string.
  markPx: string;
  /// Current mid price, decimal string (may be absent when one-sided).
  midPx?: string;
  /// Current funding rate, decimal string.
  funding: string;
  /// Open interest (base units), decimal string.
  openInterest: string;
  /// Current oracle price, decimal string.
  oraclePx: string;
}

/// One spot asset context inside the HL-compat `spot_meta_and_asset_ctxs`
/// response — the per-pair price / volume / supply snapshot (camelCase HL field
/// names, all magnitudes decimal strings). Positional with the spot universe.
export interface SpotAssetCtx {
  /// 24h notional (USD) volume, decimal string.
  dayNtlVlm: string;
  /// Previous-day close price, decimal string.
  prevDayPx: string;
  /// Current mark price, decimal string.
  markPx: string;
  /// Current mid price, decimal string (may be absent when one-sided).
  midPx?: string;
  /// Circulating token supply, decimal string.
  circulatingSupply: string;
}

/// A trigger detail attached to a `FrontendOpenOrder`.
export interface OrderTrigger {
  /// Trigger price, canonical decimal string (whole-USDC, tick-snapped).
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
  /// Resting price, canonical decimal string (whole-USDC, tick-snapped).
  px: string;
  /// Remaining size, canonical decimal string (whole units).
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
  entry_ntl: string;
  /// Effective margin mode.
  mode: 'cross' | 'isolated' | 'strict_iso';
  /// Per-asset leverage multiple.
  lev: number;
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
