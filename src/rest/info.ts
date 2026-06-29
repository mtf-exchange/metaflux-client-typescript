// MTF-native `/info` read API — typed request builders + envelope unwrap.
//
// Byte-for-byte mirror of the server's `/info` dispatcher and per-handler
// shapes (per the KB spec metaflux-knowledges/api/rest/info.md). Every request is a
// `POST /info` whose body is `{"type": "<discriminator>", ...params}` —
// snake_case field names, the exact convention the node decodes. The node's
// `/info` surface is MTF-native ONLY; the HL `type` aliases (`meta` etc.) live
// on the gateway's hl_compat layer, not here.
//
// ENVELOPE. Every successful response is `{"type": "<query>", "data": {...}}`.
// `post` validates the echoed `type` and returns the unwrapped `data` typed —
// the unwrap lives in exactly one place (`post`). The `raw<T>()` escape hatch
// returns the unwrapped `data` too (use `rawEnvelope` for the full envelope).
//
// KEYING. The node `/info` is keyed by `0x` hex address for account / staking /
// vault / user reads (`account_state`, `staking_state`, `frontend_open_orders`,
// every hl_parity user read), by `vault` (0x) for `vault_state`, by `asset_id`
// or `coin` for `market_info`, and by `market_id` (u32) for the book / trade /
// funding reads. The account-history reads (`open_orders`, `user_fills`,
// `agents`, `sub_accounts`) accept EITHER `address` (0x) OR `account_id` (u64).
// There is NO numeric-id-only keying for accounts and NO gateway id translation
// on this surface.
//
// Money magnitudes that can exceed JS `Number.MAX_SAFE_INTEGER` (2^53) are
// typed `string` in `../types/info/index.js` to match the node's decimal-string
// encoding; ids / counts / bps stay `number`.

import { httpRequest } from './http.js';
import type {
  AccountState,
  ActiveAssetData,
  Agents,
  BlockInfo,
  Candle,
  DelegatorSummary,
  ExchangeStatus,
  FeeSchedule,
  FrontendOpenOrders,
  FundingHistory,
  GossipRootIps,
  L2Book,
  LeadingVaults,
  Liquidatable,
  MarginTable,
  MarketInfo,
  MaxBuilderFee,
  MaxMarketOrderNtls,
  Mip3ActiveBids,
  NodeInfo,
  OpenOrders,
  PerpDexs,
  PerpsAtOpenInterestCap,
  RecentTrades,
  SpotClearinghouseState,
  SpotDeployState,
  SpotMeta,
  StakingState,
  SubAccounts,
  UserFills,
  UserRateLimit,
  UserRole,
  UserToMultiSigSigners,
  UserVaultEquities,
  ValidatorL1Votes,
  ValidatorSummaries,
  VaultState,
  VaultSummaries,
  WebData2,
} from '../types/info/index.js';

/// The committed `{type, data}` response envelope every `/info` query returns.
interface InfoEnvelope<T> {
  type: string;
  data: T;
}

/// An account-scoped read accepts EITHER a `0x` address OR an internal
/// `account_id` (u64). Used by `open_orders` / `user_fills` / `agents` /
/// `sub_accounts`, mirroring the node's `resolve_account`.
export type AccountRef = { address: string } | { account_id: number };

/// `/info` namespace handle. Each method POSTs a typed `{"type": ...}` body to
/// `POST <baseUrl>/info`, validates the `{type, data}` envelope, and returns
/// the unwrapped `data`.
///
/// No signing required — these are read-only queries. Construct via
/// `Client.info` or directly with a base URL.
export class InfoApi {
  constructor(private readonly baseUrl: string) {}

  // ── documented core reads ──────────────────────────────────────────────

  /// `node_info` — static node identity + protocol version.
  async nodeInfo(): Promise<NodeInfo> {
    return this.post<NodeInfo>({ type: 'node_info' });
  }

  /// `account_state` — rich per-account snapshot keyed by `address` (0x hex).
  async accountState(address: string): Promise<AccountState> {
    return this.post<AccountState>({ type: 'account_state', address });
  }

  /// `market_info` — rich per-market snapshot by canonical `asset_id` (u32).
  async marketInfo(assetId: number): Promise<MarketInfo> {
    return this.post<MarketInfo>({ type: 'market_info', asset_id: assetId });
  }

  /// `market_info` — rich per-market snapshot by human-readable `coin`.
  async marketInfoByCoin(coin: string): Promise<MarketInfo> {
    return this.post<MarketInfo>({ type: 'market_info', coin });
  }

  /// `markets` — every registered MIP-3 perp market (array of `MarketInfo`).
  async markets(): Promise<MarketInfo[]> {
    return this.post<MarketInfo[]>({ type: 'markets' });
  }

  /// `vault_state` — per-vault snapshot keyed by vault `address` (0x hex).
  async vaultState(vaultAddress: string): Promise<VaultState> {
    return this.post<VaultState>({ type: 'vault_state', vault: vaultAddress });
  }

  /// `staking_state` — per-account staking snapshot keyed by `address` (0x).
  async stakingState(address: string): Promise<StakingState> {
    return this.post<StakingState>({ type: 'staking_state', address });
  }

  /// `fee_schedule` — protocol fee schedule.
  async feeSchedule(): Promise<FeeSchedule> {
    return this.post<FeeSchedule>({ type: 'fee_schedule' });
  }

  // ── book / trade / account-history reads ────────────────────────────────

  /// `open_orders` — account-scoped resting orders. Keyed by `address` (0x) or
  /// `account_id` (u64).
  async openOrders(ref: AccountRef): Promise<OpenOrders> {
    return this.post<OpenOrders>({ type: 'open_orders', ...ref });
  }

  /// `l2_book` — market-scoped aggregated bid/ask levels by `market_id` (u32).
  async l2Book(marketId: number): Promise<L2Book> {
    return this.post<L2Book>({ type: 'l2_book', market_id: marketId });
  }

  /// `recent_trades` — market-scoped trade tape by `market_id` (u32).
  async recentTrades(marketId: number): Promise<RecentTrades> {
    return this.post<RecentTrades>({ type: 'recent_trades', market_id: marketId });
  }

  /// `user_fills` — account-scoped fill history. Keyed by `address` (0x) or
  /// `account_id` (u64).
  async userFills(ref: AccountRef): Promise<UserFills> {
    return this.post<UserFills>({ type: 'user_fills', ...ref });
  }

  /// `funding_history` — market-scoped funding premium samples by `market_id`.
  async fundingHistory(marketId: number): Promise<FundingHistory> {
    return this.post<FundingHistory>({ type: 'funding_history', market_id: marketId });
  }

  /// `candle` — historical OHLCV bars for `(coin, interval)` over a window.
  ///
  /// The REST companion to the live `candles` WS channel. `coin` is a market
  /// **symbol** (e.g. `"BTC"`), NOT a numeric asset id — unlike the other
  /// market-scoped reads here. `interval` is one of
  /// `1m`/`5m`/`15m`/`1h`/`4h`/`1d`. `startTime` / `endTime` are unix-ms filters
  /// on bar open, sent as `start_time` / `end_time` ONLY when provided
  /// (omitted = unbounded / from 0). Bars come oldest-first by `open_time`; the
  /// newest element is the still-forming bar.
  ///
  /// **Price plane.** The returned `open` / `close` / `high` / `low` are
  /// whole-USDC human-dollar decimal strings (`"67042.50"`, tick-snapped) — the
  /// SAME canonical plane the WS `candles` frame now emits, so REST history and
  /// the live WS bar line up with no rescaling. `volume` is base units (coin
  /// size, NOT notional); `num_trades` is a fill count.
  ///
  /// GATEWAY-served, not node: must hit `<net>-gateway.mtf.exchange/info`; a
  /// bare node returns `unknown info type: candle`. An empty array is the
  /// honest-empty answer for an unsupported `interval`, a market with no indexed
  /// trades, or a deployment with no indexer wired.
  async candle(
    coin: string,
    interval: string,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'candle',
      coin,
      interval,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<Candle[]>(body);
  }

  /// `block_info` — latest committed block metadata. No parameters.
  async blockInfo(): Promise<BlockInfo> {
    return this.post<BlockInfo>({ type: 'block_info' });
  }

  /// `agents` — approved agent / API wallets. Keyed by `address` (0x) or
  /// `account_id` (u64).
  async agents(ref: AccountRef): Promise<Agents> {
    return this.post<Agents>({ type: 'agents', ...ref });
  }

  /// `sub_accounts` — sub-accounts of an account. Keyed by `address` (0x) or
  /// `account_id` (u64).
  async subAccounts(ref: AccountRef): Promise<SubAccounts> {
    return this.post<SubAccounts>({ type: 'sub_accounts', ...ref });
  }

  /// `mip3_active_bids` — MIP-3 permissionless perp-deploy auction snapshot.
  async mip3ActiveBids(): Promise<Mip3ActiveBids> {
    return this.post<Mip3ActiveBids>({ type: 'mip3_active_bids' });
  }

  // ── HL-node parity reads ────────────────────────────────────────────────

  /// `spot_meta` — spot pair universe + token registry. No parameters.
  ///
  /// Each pair's `name` is derived as `{base}/{quote}` from the token
  /// registry; the numeric `id` is the compact `coin` label spot prints carry
  /// on the WS `trades` / `candles` / `fills` channels.
  async spotMeta(): Promise<SpotMeta> {
    return this.post<SpotMeta>({ type: 'spot_meta' });
  }

  /// `spot_clearinghouse_state` — per-account spot token balances by `address`.
  async spotClearinghouseState(address: string): Promise<SpotClearinghouseState> {
    return this.post<SpotClearinghouseState>({
      type: 'spot_clearinghouse_state',
      address,
    });
  }

  /// `exchange_status` — global trading status. No parameters.
  async exchangeStatus(): Promise<ExchangeStatus> {
    return this.post<ExchangeStatus>({ type: 'exchange_status' });
  }

  /// `frontend_open_orders` — resting orders + tif / cloid / trigger by
  /// `address` (0x).
  async frontendOpenOrders(address: string): Promise<FrontendOpenOrders> {
    return this.post<FrontendOpenOrders>({ type: 'frontend_open_orders', address });
  }

  /// `liquidatable` — accounts currently flagged for liquidation. No params.
  async liquidatable(): Promise<Liquidatable> {
    return this.post<Liquidatable>({ type: 'liquidatable' });
  }

  /// `active_asset_data` — a user's per-asset leverage / margin-mode / max
  /// trade by `address` (0x) + `asset_id` (u32).
  async activeAssetData(address: string, assetId: number): Promise<ActiveAssetData> {
    return this.post<ActiveAssetData>({
      type: 'active_asset_data',
      address,
      asset_id: assetId,
    });
  }

  /// `max_market_order_ntls` — per-asset max market-order notional. No params.
  async maxMarketOrderNtls(): Promise<MaxMarketOrderNtls> {
    return this.post<MaxMarketOrderNtls>({ type: 'max_market_order_ntls' });
  }

  /// `vault_summaries` — all vaults summary. No parameters.
  async vaultSummaries(): Promise<VaultSummaries> {
    return this.post<VaultSummaries>({ type: 'vault_summaries' });
  }

  /// `user_vault_equities` — vaults a user has deposited into by `address` (0x).
  async userVaultEquities(address: string): Promise<UserVaultEquities> {
    return this.post<UserVaultEquities>({ type: 'user_vault_equities', address });
  }

  /// `leading_vaults` — vaults led by the user by `address` (0x).
  async leadingVaults(address: string): Promise<LeadingVaults> {
    return this.post<LeadingVaults>({ type: 'leading_vaults', address });
  }

  /// `user_rate_limit` — a user's action stats / rate-limit budget by `address`.
  async userRateLimit(address: string): Promise<UserRateLimit> {
    return this.post<UserRateLimit>({ type: 'user_rate_limit', address });
  }

  /// `spot_deploy_state` — MIP-1 spot-pair-deploy gas-auction state. No params.
  async spotDeployState(): Promise<SpotDeployState> {
    return this.post<SpotDeployState>({ type: 'spot_deploy_state' });
  }

  /// `delegator_summary` — staking summary for an `address` (0x).
  async delegatorSummary(address: string): Promise<DelegatorSummary> {
    return this.post<DelegatorSummary>({ type: 'delegator_summary', address });
  }

  /// `max_builder_fee` — approved builder-fee ceiling for `(address, builder)`,
  /// both 0x.
  async maxBuilderFee(address: string, builder: string): Promise<MaxBuilderFee> {
    return this.post<MaxBuilderFee>({ type: 'max_builder_fee', address, builder });
  }

  /// `user_to_multi_sig_signers` — multisig config for an `address` (0x).
  async userToMultiSigSigners(address: string): Promise<UserToMultiSigSigners> {
    return this.post<UserToMultiSigSigners>({
      type: 'user_to_multi_sig_signers',
      address,
    });
  }

  /// `user_role` — derived account role for an `address` (0x).
  async userRole(address: string): Promise<UserRole> {
    return this.post<UserRole>({ type: 'user_role', address });
  }

  /// `perps_at_open_interest_cap` — assets whose OI is at/over the cap. No params.
  async perpsAtOpenInterestCap(): Promise<PerpsAtOpenInterestCap> {
    return this.post<PerpsAtOpenInterestCap>({ type: 'perps_at_open_interest_cap' });
  }

  /// `validator_l1_votes` — current validator L1 votes. No parameters.
  async validatorL1Votes(): Promise<ValidatorL1Votes> {
    return this.post<ValidatorL1Votes>({ type: 'validator_l1_votes' });
  }

  /// `margin_table` — the margin-tier table (one effective tier per market).
  async marginTable(): Promise<MarginTable> {
    return this.post<MarginTable>({ type: 'margin_table' });
  }

  /// `perp_dexs` — list the perp DEX(es). No parameters.
  async perpDexs(): Promise<PerpDexs> {
    return this.post<PerpDexs>({ type: 'perp_dexs' });
  }

  /// `validator_summaries` — per-validator snapshot. No parameters.
  async validatorSummaries(): Promise<ValidatorSummaries> {
    return this.post<ValidatorSummaries>({ type: 'validator_summaries' });
  }

  /// `gossip_root_ips` — configured gossip root/seed peer endpoints. No params.
  async gossipRootIps(): Promise<GossipRootIps> {
    return this.post<GossipRootIps>({ type: 'gossip_root_ips' });
  }

  /// `web_data2` — composite frontend snapshot by `address` (0x).
  async webData2(address: string): Promise<WebData2> {
    return this.post<WebData2>({ type: 'web_data2', address });
  }

  // ── escape hatches ──────────────────────────────────────────────────────

  /// Raw escape hatch — POST an arbitrary `{type, ...}` body to `/info`,
  /// validate the envelope, and return the unwrapped `data` typed. For request
  /// shapes the SDK doesn't yet model.
  async raw<T = unknown>(body: { type: string; [k: string]: unknown }): Promise<T> {
    return this.post<T>(body);
  }

  /// Like `raw`, but returns the full `{type, data}` envelope rather than just
  /// the unwrapped `data` — for callers that want to inspect the echoed `type`.
  async rawEnvelope<T = unknown>(body: {
    type: string;
    [k: string]: unknown;
  }): Promise<InfoEnvelope<T>> {
    return httpRequest<InfoEnvelope<T>>(this.baseUrl, '/info', {
      method: 'POST',
      json: body,
    });
  }

  /// POST a typed body, validate the `{type, data}` envelope echoes the request
  /// `type`, and return the unwrapped `data`. The single place the envelope is
  /// peeled — every typed method routes through here.
  private async post<T>(body: { type: string; [k: string]: unknown }): Promise<T> {
    const env = await httpRequest<InfoEnvelope<T>>(this.baseUrl, '/info', {
      method: 'POST',
      json: body,
    });
    if (env === null || typeof env !== 'object' || !('data' in env)) {
      throw new TypeError(
        `/info ${body.type}: response is not a {type, data} envelope`,
      );
    }
    if (env.type !== body.type) {
      throw new TypeError(
        `/info ${body.type}: response type mismatch — got '${env.type}'`,
      );
    }
    return env.data;
  }
}
