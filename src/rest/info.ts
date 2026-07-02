// MTF-native `/info` read API — typed request builders + envelope unwrap.
//
// Byte-for-byte mirror of the server's `/info` dispatcher and per-handler
// shapes (per the KB spec metaflux-knowledges/api/rest/info.md). Every request
// is a `POST /info` whose body is `{"type": "<discriminator>", ...params}` —
// snake_case field names, the exact convention the node decodes.
//
// ENVELOPE. Every successful response is `{"type": "<query>", "data": {...}}`.
// `post` validates the echoed `type` and returns the unwrapped `data` typed —
// the unwrap lives in exactly one place (`post`). The `raw<T>()` escape hatch
// returns the unwrapped `data` too (use `rawEnvelope` for the full envelope).
//
// KEYING (consolidated surface). Market-scoped reads (`l2_book`,
// `recent_trades`, `trades_by_time`, `funding_history`, `market_info`,
// `candle_snapshot`, `active_asset_data`) are keyed by `coin` — the market
// SYMBOL string (e.g. `"BTC"`). Account-scoped reads (`open_orders`,
// `user_fills`, `user_fills_by_time`, `agents`, `sub_accounts`, every user
// read) are keyed by `address` (0x hex). The old numeric `market_id` /
// `asset_id` / `account_id` request params were REMOVED server-side; the
// numeric asset plane survives ONLY on signed `/exchange` actions.
//
// Money magnitudes that can exceed JS `Number.MAX_SAFE_INTEGER` (2^53) are
// typed `string` in `../types/info/index.js` to match the node's decimal-string
// encoding; ids / counts stay `number`.

import { httpRequest } from './http.js';
import type {
  AccountState,
  ActiveAssetData,
  Agents,
  BlockInfo,
  CandleSnapshot,
  DelegatorSummary,
  ExchangeStatus,
  FeeSchedule,
  FrontendOpenOrders,
  FundingHistory,
  GossipRootIps,
  L2Book,
  LeadingVaults,
  Liquidatable,
  MarketInfo,
  Markets,
  MaxBuilderFee,
  MaxMarketOrderNtls,
  Mip3ActiveBids,
  NodeInfo,
  OpenOrders,
  PerpDexs,
  PerpsAtOpenInterestCap,
  PredictedFunding,
  RecentTrades,
  SpotClearinghouseState,
  SpotDeployState,
  SpotMeta,
  StakingState,
  SubAccounts,
  TradesByTime,
  UserFills,
  UserFillsByTime,
  UserRateLimit,
  UserRole,
  UserToMultiSigSigners,
  UserVaultEquities,
  ValidatorL1Votes,
  ValidatorSummaries,
  VaultState,
  VaultSummaries,
} from '../types/info/index.js';

/// The committed `{type, data}` response envelope every `/info` query returns.
interface InfoEnvelope<T> {
  type: string;
  data: T;
}

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

  /// `market_info` — rich per-market snapshot keyed by `coin` (the market
  /// symbol, e.g. `"BTC"`). Carries the inline `margin_tiers` ladder.
  async marketInfo(coin: string): Promise<MarketInfo> {
    return this.post<MarketInfo>({ type: 'market_info', coin });
  }

  /// `markets` — the full market universe: `{perp: MarketInfo[], spot:
  /// SpotMeta}`. Perp records are keyed by `coin` and carry the inline
  /// `margin_tiers` ladder.
  async markets(): Promise<Markets> {
    return this.post<Markets>({ type: 'markets' });
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

  /// `open_orders` — account-scoped resting orders, keyed by `address` (0x).
  async openOrders(address: string): Promise<OpenOrders> {
    return this.post<OpenOrders>({ type: 'open_orders', address });
  }

  /// `l2_book` — market-scoped aggregated bid/ask levels, keyed by `coin`.
  async l2Book(coin: string): Promise<L2Book> {
    return this.post<L2Book>({ type: 'l2_book', coin });
  }

  /// `recent_trades` — market-scoped trade tape, keyed by `coin`. Optional
  /// `limit` caps the most-recent records returned (absent = the full ring).
  async recentTrades(coin: string, limit?: number): Promise<RecentTrades> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'recent_trades',
      coin,
    };
    if (limit !== undefined) body.limit = limit;
    return this.post<RecentTrades>(body);
  }

  /// `trades_by_time` — the trade tape filtered to an inclusive `[startTime,
  /// endTime]` window (unix ms over each record's consensus `time`; an
  /// omitted bound is open). Sent as `start_time` / `end_time` ONLY when
  /// provided. Ring order (oldest first).
  async tradesByTime(
    coin: string,
    startTime?: number,
    endTime?: number,
  ): Promise<TradesByTime> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'trades_by_time',
      coin,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<TradesByTime>(body);
  }

  /// `user_fills` — account-scoped fill history, keyed by `address` (0x).
  /// Optional `limit` caps the most-recent records returned.
  async userFills(address: string, limit?: number): Promise<UserFills> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_fills',
      address,
    };
    if (limit !== undefined) body.limit = limit;
    return this.post<UserFills>(body);
  }

  /// `user_fills_by_time` — fill history filtered to an inclusive
  /// `[startTime, endTime]` window (unix ms; an omitted bound is open).
  /// Oldest first; same record shape as `user_fills`.
  async userFillsByTime(
    address: string,
    startTime?: number,
    endTime?: number,
  ): Promise<UserFillsByTime> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_fills_by_time',
      address,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<UserFillsByTime>(body);
  }

  /// `funding_history` — market-scoped funding samples, keyed by `coin`.
  /// Each sample carries the raw `premium` and the clamped `funding_rate`
  /// that settlement actually charges.
  async fundingHistory(coin: string): Promise<FundingHistory> {
    return this.post<FundingHistory>({ type: 'funding_history', coin });
  }

  /// `predicted_fundings` — per-market predicted funding rate (clamped — the
  /// actually-charged rate) + the next aligned settlement boundary (ms).
  async predictedFundings(): Promise<PredictedFunding[]> {
    return this.post<PredictedFunding[]>({ type: 'predicted_fundings' });
  }

  /// `candle_snapshot` — historical OHLCV bars for `(coin, interval)` over an
  /// optional window. The single candle query on this surface, and the REST
  /// companion to the live `candles` WS channel.
  ///
  /// `coin` is the market symbol (`"BTC"`); `interval` is one of
  /// `1m`/`5m`/`15m`/`1h`/`4h`/`1d`. `startTime` / `endTime` are unix-ms
  /// filters on bar open, sent as `start_time` / `end_time` ONLY when
  /// provided. Bars come oldest-first (compact keys, `o`/`c`/`h`/`l`
  /// whole-USDC decimal strings); the newest element is the still-forming bar.
  ///
  /// GATEWAY-served, not node: must hit `<net>-gateway.mtf.exchange/info`; a
  /// bare node returns `unknown info type: candle_snapshot`.
  async candleSnapshot(
    coin: string,
    interval: string,
    startTime?: number,
    endTime?: number,
  ): Promise<CandleSnapshot> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'candle_snapshot',
      coin,
      interval,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<CandleSnapshot>(body);
  }

  /// `block_info` — latest committed block metadata. No parameters.
  async blockInfo(): Promise<BlockInfo> {
    return this.post<BlockInfo>({ type: 'block_info' });
  }

  /// `agents` — approved agent / API wallets, keyed by `address` (0x).
  async agents(address: string): Promise<Agents> {
    return this.post<Agents>({ type: 'agents', address });
  }

  /// `sub_accounts` — sub-accounts of an account, keyed by `address` (0x).
  async subAccounts(address: string): Promise<SubAccounts> {
    return this.post<SubAccounts>({ type: 'sub_accounts', address });
  }

  /// `mip3_active_bids` — MIP-3 permissionless perp-deploy auction snapshot.
  async mip3ActiveBids(): Promise<Mip3ActiveBids> {
    return this.post<Mip3ActiveBids>({ type: 'mip3_active_bids' });
  }

  // ── node snapshot reads ─────────────────────────────────────────────────

  /// `spot_meta` — spot pair universe + token registry. No parameters.
  ///
  /// Each pair's `name` is derived as `{base}/{quote}` from the token
  /// registry; the numeric `id` is the compact `coin` label spot prints carry
  /// on the WS `trades` / `candles` / `fills` channels. The same object is
  /// embedded in `markets` as `spot`.
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
  /// trade, keyed by `address` (0x) + `coin` (market symbol).
  async activeAssetData(address: string, coin: string): Promise<ActiveAssetData> {
    return this.post<ActiveAssetData>({
      type: 'active_asset_data',
      address,
      coin,
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

  // ── escape hatches ──────────────────────────────────────────────────────

  /// Raw escape hatch — POST an arbitrary `{type, ...}` body to `/info`,
  /// validate the envelope, and return the unwrapped `data` typed. For request
  /// shapes the SDK doesn't yet model (e.g. `oracle_sources`,
  /// `fba_batch_state`, `order_status`, governance reads).
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
