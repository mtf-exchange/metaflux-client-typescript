// Node-snapshot / parity response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/api/rest/info.md. Field
// names are the exact snake_case keys the node emits inside `{type, data}.data`.
// Money magnitudes that can exceed 2^53 are typed `string`.

import type {
  MarketDynamic,
  MarketStatic,
  TokenEvmContract,
} from './core.js';

/// One spot pair inside `SpotMeta` (also `markets.spot.pairs`).
export interface SpotPair {
  /// Numeric pair id — also the compact `coin` label spot prints carry on the
  /// WS `trades` / `candles` / `fills` channels. The wire renamed this from
  /// `id`; a spot order names its pair by this number.
  signing_id: number;
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
  /// Size precision of the pair's BASE token: a spot order `size` is
  /// `whole_units × 10^sz_decimals`. Load-bearing — do not derive it from the
  /// quote token or from a perp of the same symbol.
  sz_decimals: number;
  /// Pair mark price, decimal string. `null` on an inactive pair — the wire
  /// sends an explicit null, not an absent field.
  mark_px: string | null;
  /// Order-book mid price, decimal string; `null` when one-sided.
  mid_px: string | null;
  /// Previous-day close price, decimal string; `null` if unset.
  prev_day_px: string | null;
  /// 24h notional (USD) volume, decimal string.
  day_ntl_vlm: string;
  /// Circulating base-token supply, decimal string.
  circulating_supply: string;
  /// Address that registered the pair.
  deployer: string;
  /// Registration time, consensus milliseconds; `0` for a genesis pair.
  registered_at: number;
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
  /// EVM contract bound to the token as an OBJECT `{address,
  /// evm_extra_wei_decimals}`, or `null` when it has no binding.
  evm_contract: TokenEvmContract | null;
  /// Whether the token is a canonical (genesis-seeded) listing.
  is_canonical: boolean;
  /// Token system address (0x).
  system_address: string;
  /// Deterministic token id hash (`0x` + 32 bytes).
  token_id: string;
  /// Total supply of the token, decimal string. (A perp market's underlying
  /// `token` block instead carries `circulating_supply` — distinct key.)
  total_supply: string;
}

/// `spot_meta` — spot pair universe + token registry. The same object is
/// embedded as `markets.spot`.
export interface SpotMeta {
  /// Registered spot pairs (token-registration sentinels excluded).
  pairs: SpotPair[];
  /// Token registry with per-token decimals.
  tokens: SpotToken[];
}

/// `markets` — the DYNAMIC market universe: live price / funding / OI for every
/// perp, plus the spot pair/token registry.
///
/// The perp rows are `MarketDynamic`, NOT `MarketStatic`. This read serves no
/// precision grid, no leverage ladder and no trade-control flag; read
/// `marketsMeta()` for those and merge by `coin`. The `spot` sub-object is
/// identical in both reads.
export interface Markets {
  /// Registered perp markets, dynamic half only.
  perp: MarketDynamic[];
  /// Spot universe (same object as the `spot_meta` read).
  spot: SpotMeta;
}

/// `markets_meta` — the STATIC market universe: precision grids, leverage
/// ladders and trade-control flags, plus the same spot registry `markets`
/// serves. Long-cacheable.
export interface MarketsMeta {
  /// Registered perp markets, static half only.
  perp: MarketStatic[];
  /// Spot universe (same object as the `markets` read).
  spot: SpotMeta;
}

/// `exchange_status` — global trading status.
export interface ExchangeStatus {
  /// Spot trading globally disabled.
  spot_disabled: boolean;
  /// A post-only window is in force — new orders must be maker-only.
  post_only: boolean;
  /// `true` once any MIP-3 market/pair spec is registered.
  mip3_enabled: boolean;
  /// A pending upgrade halt. It does NOT say when: the height that dated it is
  /// operator detail and is no longer published here.
  frozen: boolean;
  /// Consensus block time, ms — the "as of" for every field above.
  timestamp: number;

  /// @deprecated Removed from the public status. Present only while an older
  /// gateway is still deployed; read `post_only` instead.
  post_only_until_time?: number;
  /// @deprecated Removed from the public status. Read `post_only` instead.
  post_only_until_height?: number;
  /// @deprecated Removed from the public status. An older gateway also computes
  /// `frozen` with a stale comparison that reads `true` forever once any
  /// upgrade completes — do not trust either field against an old deployment.
  scheduled_freeze_height?: number | null;
  /// @deprecated Removed from the public status.
  replay_complete?: boolean;
}



/// `active_asset_data` — a user's per-asset leverage / margin-mode / tradeable
/// size, keyed by `(address, coin)`. The WS `markets` channel carries
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
  /// Remaining market-wide OI headroom in size units, or `null` when the market
  /// is UNCAPPED. It is shared headroom that other traders consume, not a
  /// per-user guarantee. The retired `"0"` sentinel meant uncapped, so a client
  /// that clamped order size to this field refused to trade on exactly the
  /// markets that had no cap.
  max_trade_size: string | null;
  /// Whether the user has a non-zero position on this asset.
  has_position: boolean;
}

/// One vault summary row of `vault_summaries`.
///
/// Every vault appears, and each row names its `leader`. To list the vaults ONE
/// address leads, filter these rows on `leader`; there is no per-leader read.
export interface VaultSummary {
  /// Vault id.
  id: number;
  /// Vault on-chain address (0x).
  address: string;
  /// Vault display name.
  name: string;
  /// Vault leader address (0x).
  leader: string;
  /// NAV proxy (high-water mark), WHOLE-USDC decimal string.
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

/// One vault equity entry inside `AccountOverview.vault.equities`.
export interface VaultEquity {
  /// Vault id.
  vault_id: number;
  /// Vault address (0x).
  vault_address: string;
  /// Caller's share count in WHOLE shares, as a decimal string. NOT the raw
  /// 10^18 integer: the node divides before it answers. Send this exact string
  /// back to `vault_withdraw`, which reads the same plane. Do not multiply it,
  /// and do not round-trip it through `Number` — see `WholeShares`.
  shares: string;
  /// `shares × share_price`, decimal string (truncated).
  equity: string;
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

/// `spot_deploy_auction` — MIP-1 spot-pair-deploy gas-auction state.
///
/// The node answers this read under the older name `spot_deploy_state` until
/// the release that ships the rename. Same body either way.
export interface SpotDeployAuction {
  /// Current round.
  auction_round: number;
  /// Leading bid, decimal string.
  current_bid: string;
  /// Current high bidder (0x), or `null`.
  current_winner: string | null;
  /// Auction close timestamp (consensus ms).
  auction_end: number;
  /// Auction start timestamp (consensus ms).
  started_at: number;
  /// Cumulative burned winning-bid notional, decimal string.
  total_burned: string;
  /// Total escrowed deposit (base units), decimal string.
  deposit: string;
}

/// The aggregate staking totals inside `AccountOverview.staking.summary`.
///
/// The three balances are DISJOINT — add them for the whole staked holding.
/// `undelegated` (on `StakingState`) is the free pool a `token_delegate` draws
/// from, and the only one `staking_withdraw` returns to spot with no unbonding
/// window.
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

/// One validator L1 vote.
export interface ValidatorL1Vote {
  /// Vote round.
  round: number;
  /// Casting validator address (0x).
  validator: string;
  /// Submission timestamp (consensus ms).
  submitted_at: number;
}

/// `validator_l1_votes` — current validator L1 votes.
export interface ValidatorL1Votes {
  /// Latest accepted vote round.
  latest_round: number;
  /// Votes.
  votes: ValidatorL1Vote[];
}

/// One perp DEX entry inside `PerpDexs.dexs`.
export interface PerpDex {
  /// DEX index in the exchange's perp-dex list.
  index: number;
  /// Number of asset books in the DEX.
  n_assets: number;
  /// Market symbols in the DEX.
  assets: string[];
}

/// `perp_dexs` — the perp DEX(es) plus the governed deploy limits.
export interface PerpDexs {
  /// Perp DEXes.
  dexs: PerpDex[];
  /// The governance-set MIP-3 deploy and per-market limits. Absent on a node
  /// that predates the merge of the old `perp_dex_limits` read.
  limits?: PerpDexLimits;
}

/// The governance-set MIP-3 deploy and per-market limits, inside `PerpDexs`.
///
/// The unit planes are load-bearing and deliberately explicit in the names.
export interface PerpDexLimits {
  /// Permissionless (MIP-3) perp deploy enabled.
  mip3_enabled: boolean;
  /// Deployer SELF-STAKE floor, MTF base units as a decimal string.
  min_deploy_stake_base: string;
  /// Permissionless-deploy staking BOND, whole-MTF decimal string. An
  /// independent governance knob from `min_deploy_stake_base` — two
  /// thresholds, not one value on two planes.
  min_deploy_stake_mtf: string;
  /// Deploy gas-auction minimum bid, whole-USDC decimal string.
  gas_auction_min_bid: string;
  /// Gas-auction window length, in blocks.
  auction_duration_blocks: number;
  /// Ceiling on the per-market deployer fee share, whole bps decimal string.
  deployer_fee_cap_bps: string;
  /// Dutch-auction start-price multiplier over the minimum bid.
  dutch_start_multiplier: string;
  /// Per-market ceilings.
  per_market_limits: PerpDexPerMarketLimits;
}

/// The per-market ceilings inside `PerpDexLimits`.
export interface PerpDexPerMarketLimits {
  /// Per-market open-interest cap, size base units as a decimal string.
  max_oi: string;
  /// Max leverage a deployed market may offer.
  max_leverage: number;
  /// Per-market taker-fee ceiling, decimal bps string.
  max_taker_fee_bps: string;
  /// Per-market open-interest growth-rate cap, size base units per second.
  max_oi_per_second: string;
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
  jailed_at: number | null;
  /// Earliest unjail ts (consensus ms), or `null` if not jailed.
  unjail_at: number | null;
  /// First epoch the validator was active.
  first_active_epoch: number;
}

/// `validator_summaries` — per-validator snapshot.
export interface ValidatorSummaries {
  /// Σ stake across all validators, decimal string.
  total_stake: string;
  /// Size of the active set.
  n_active: number;
  /// Validator rows.
  validators: ValidatorSummary[];
}

/// One advertised node. The five fields map one-to-one onto a joining node's
/// own peer config, so a row is copied field-for-field and dialed.
export interface AdvertisedPeer {
  /// The node's numeric id.
  id: number;
  /// Public gossip endpoint, `host:port`.
  gossip: string;
  /// Public peer-RPC endpoint, `host:port`.
  peer_rpc: string;
  /// Public auth endpoint, `host:port`.
  auth: string;
  /// Compressed secp256k1 public key for the peer's TCP auth. Absent when the
  /// operator did not publish it.
  pubkey_hex?: string;
}

/// `gossip_root_ips` — the nodes this deployment advertises for peer discovery.
export interface GossipRootIps {
  /// One row per advertised node. A node that advertises nothing is absent, so
  /// an empty array is the honest answer, not an error.
  peers: AdvertisedPeer[];
}

/// One live TWAP parent inside a `UserTwaps`.
///
/// The row is the parent SCHEDULE, not a fill. Each slice it fires lands on the
/// normal fill tape under the parent's market.
export interface UserTwap {
  /// Parent TWAP id — the number `twap_cancel` names.
  twap_id: number;
  /// Market symbol the parent trades.
  coin: string;
  /// Side, `"B"` (bid) or `"A"` (ask) — the same token `user_fills` uses.
  side: 'B' | 'A';
  /// Total size the parent will work, on the market's size scale.
  sz: string;
  /// Size already filled, same scale. Subtract it from `sz` for the residual;
  /// there is no separate remaining field.
  executed_sz: string;
  /// How many slices the parent is cut into.
  slices_total: number;
  /// How many slices have fired.
  slices_done: number;
  /// Gap between slices, in milliseconds. A DURATION, not a timestamp.
  delay_ms: number;
  /// When the last slice fired (consensus ms). `0` before the first one.
  last_fire_ts: number;
  /// Whether the parent may only reduce an existing position.
  reduce_only: boolean;
}

/// `user_twaps` — the account's ACTIVE TWAP parents, keyed by `address`.
///
/// LIVE SET ONLY. A parent that completes or is cancelled leaves the tracker,
/// so an empty list means nothing is working now — it is not a history read.
///
/// It spans every perp dex AND the spot parents, so a market outside the core
/// dex is included.
export interface UserTwaps {
  /// Echo of the requested account, 0x hex.
  address: string;
  /// Active parents. Empty when none are working.
  twaps: UserTwap[];
}

/// One broker-fee grant inside an `ApprovedBuilders`.
export interface ApprovedBuilder {
  /// The broker the account approved, 0x hex.
  builder: string;
  /// The CEILING this account allows that broker to charge per order, whole bps
  /// as a decimal string. It is not a rate: the broker sets the actual
  /// `builder_fee` on each order, and the node refuses an order above this cap.
  max_fee_bps: string;
}

/// `approved_builders` — every broker-fee grant one account has approved, keyed
/// by `address`.
///
/// It answers the point lookup too: to check one broker, read its row. An empty
/// array means the account approved nobody, so every broker-fee order it signs
/// is refused.
export interface ApprovedBuilders {
  /// Echo of the requested account, 0x hex.
  address: string;
  /// One row per approved broker. Empty when none are approved.
  builders: ApprovedBuilder[];
}
