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
  CandleType,
  DelegatorSummary,
  EarnState,
  EncodeAction,
  ExchangeStatus,
  FeeSchedule,
  FundingHistory,
  GossipRootIps,
  HistoricalOrders,
  L2Book,
  L2BookParams,
  LeadingVaults,
  Liquidatable,
  MarketInfo,
  Markets,
  MarketsMeta,
  MaxBuilderFee,
  MaxMarketOrderNtls,
  Mip3ActiveBids,
  NodeInfo,
  OpenOrders,
  OrderStatusInfo,
  PerpDexs,
  PerpsAtOpenInterestCap,
  PmSummary,
  PredictedFunding,
  RecentTrades,
  SpotClearinghouseState,
  SpotDeployState,
  SpotMarginState,
  SpotMeta,
  StakingState,
  SubAccounts,
  TradesByTime,
  UserFills,
  UserFillsByTime,
  UserFunding,
  UserLedgerUpdates,
  UserNonFundingLedgerUpdates,
  UserPositionHistory,
  UserRateLimit,
  UserRole,
  UserToMultiSigSigners,
  UserVaultEquities,
  ValidatorL1Votes,
  ValidatorSummaries,
  VaultState,
  VaultSummaries,
  WebData,
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
  ///
  /// Positions are grouped by perp dex under `clearinghouse_state`; the core
  /// dex key is `""`. Balances are an ARRAY of `{asset, name, total, hold}`
  /// rows, USDC first. `height` / `time` stamp the committed snapshot.
  async accountState(address: string): Promise<AccountState> {
    return this.post<AccountState>({ type: 'account_state', address });
  }

  /// `web_data` — the consolidated account snapshot keyed by `address` (0x
  /// hex): vault equities and vault summaries, staking, sub-accounts, the
  /// multisig signer set, and API-wallet agents.
  ///
  /// It carries the account facets `account_state` does not. Use the two
  /// together for a full account view, or subscribe to the matching WS
  /// channels.
  async webData(address: string): Promise<WebData> {
    return this.post<WebData>({ type: 'web_data', address });
  }

  /// `market_info` — rich per-market snapshot keyed by `coin` (the market
  /// symbol, e.g. `"BTC"`). Carries the inline `margin_tiers` ladder.
  async marketInfo(coin: string): Promise<MarketInfo> {
    return this.post<MarketInfo>({ type: 'market_info', coin });
  }

  /// `markets` — the DYNAMIC market universe: `{perp: MarketDynamic[], spot:
  /// SpotMeta}`. Perp records are keyed by `coin` and carry live price /
  /// funding / open interest / the 24h ticker.
  ///
  /// This read serves NO precision grid, NO leverage ladder and NO
  /// trade-control flag. Reading `sz_decimals`, `tick_size`, `open` or `close`
  /// off one of these rows yields `undefined`; call `marketsMeta()` and merge
  /// by `coin`, or call `marketInfo()` for the union on one market.
  async markets(): Promise<Markets> {
    return this.post<Markets>({ type: 'markets' });
  }

  /// `markets_meta` — STATIC per-market metadata: the long-cacheable subset of
  /// `markets` (precision grids `sz_decimals`/`tick_size`/`step_size`, leverage
  /// + `margin_tiers` ladder, `min_order`, trade-control flags, `mark_source`,
  /// and the deprecated `asset_id` shim). Same `{perp, spot}` envelope as
  /// `markets`, but the `perp[]` records OMIT the dynamic price/funding/OI
  /// fields (`mark_px`/`oracle_px`/`open_interest`/`funding`/…) — those live on
  /// `markets`. Merge the two by `coin` when a view needs both live prices AND
  /// precision. Because it is static it can be fetched once and cached hard.
  ///
  /// A perp record may carry an optional underlying `token` block (`{id,
  /// wei_decimals, token_id, system_address, evm_contract, is_canonical,
  /// circulating_supply}`) when the perp has a registered underlying token; the
  /// spot `tokens[]` rows carry `total_supply` and an object `evm_contract`.
  /// This is also the source of the spot universe returned by `spotMeta()`
  /// (the standalone `spot_meta` /info type was removed server-side).
  async marketsMeta(): Promise<MarketsMeta> {
    return this.post<MarketsMeta>({ type: 'markets_meta' });
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

  /// `open_orders` — account-scoped resting orders across every perp AND spot
  /// book, keyed by `address` (0x). Spot resting orders appear too, labeled
  /// with the pair NAME as `coin` (e.g. `"BTC/USDC"`).
  ///
  /// Parked TP / SL / stop triggers are in the row set: they carry
  /// `tif: "trigger"` plus a populated `trigger` block. This read replaces the
  /// removed `frontend_open_orders` kind, which carried that same detail.
  async openOrders(address: string): Promise<OpenOrders> {
    return this.post<OpenOrders>({ type: 'open_orders', address });
  }

  /// `l2_book` — market-scoped aggregated bid/ask levels, keyed by `coin`.
  ///
  /// `coin` is a perp symbol (`"BTC"`) or a spot pair — its NAME (`"BTC/USDC"`)
  /// or numeric pair id; spot pairs now return real depth. The optional
  /// `params` group the book HL-style (`n_sig_figs` 2..=5; `mantissa` 1|2|5,
  /// valid ONLY with `n_sig_figs === 5`; `n_levels` ≥ 1) — each is sent ONLY
  /// when defined (the gateway validates strictly and rejects an unpaired
  /// `mantissa`).
  async l2Book(coin: string, params?: L2BookParams): Promise<L2Book> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'l2_book',
      coin,
    };
    if (params?.nSigFigs !== undefined) body.n_sig_figs = params.nSigFigs;
    if (params?.mantissa !== undefined) body.mantissa = params.mantissa;
    if (params?.nLevels !== undefined) body.n_levels = params.nLevels;
    return this.post<L2Book>(body);
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

  /// `user_position_history` — one row per CLOSED position lifecycle, keyed by
  /// `address` (0x). Newest first; optional `limit` caps the page.
  ///
  /// A position still OPEN is never returned — read the live position from
  /// `accountState()`. Check each row's `entry_complete` / `close_complete` /
  /// `funding_complete` before trusting its numbers: a degraded row is served
  /// on purpose, with `max_sz` / `avg_entry_px` null rather than wrong.
  async userPositionHistory(
    address: string,
    limit?: number,
  ): Promise<UserPositionHistory> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_position_history',
      address,
    };
    if (limit !== undefined) body.limit = limit;
    return this.post<UserPositionHistory>(body);
  }

  /// `user_position_history_by_time` — closed position lifecycles inside an
  /// inclusive `[startTime, endTime]` window (unix ms; an omitted bound is
  /// open). Oldest first.
  ///
  /// The window filters on `closed_at`, so a position OPENED before the window
  /// but CLOSED inside it IS returned. The reply does NOT echo the window.
  async userPositionHistoryByTime(
    address: string,
    startTime?: number,
    endTime?: number,
  ): Promise<UserPositionHistory> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_position_history_by_time',
      address,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<UserPositionHistory>(body);
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

  /// `candle_snapshot` — historical price bars for `(coin, interval,
  /// candleType)` over an optional window. The single candle query on this
  /// surface, and the REST companion to the live `candles` WS channel.
  ///
  /// `coin` is the market symbol (`"BTC"`); `interval` is one of
  /// `1m`/`5m`/`15m`/`1h`/`4h`/`1d`. `startTime` / `endTime` are unix-ms
  /// filters on bar open, sent as `start_time` / `end_time` ONLY when
  /// provided. Bars come oldest-first (compact keys, `o`/`c`/`h`/`l`
  /// whole-USDC decimal strings); the newest element is the still-forming bar.
  ///
  /// `candleType` picks the price series: `"mark"` (the DEFAULT, perp and spot)
  /// or `"oracle"` (perp only). It is sent as `candle_type` ONLY when provided,
  /// so an omitted value takes the node's `mark` default. The executed-trade
  /// candle is RETIRED — the node rejects `trade` and never substitutes the
  /// other series.
  ///
  /// GATEWAY-served, not node: must hit `api.<net>.mtf.exchange/info`; a
  /// bare node returns `unknown info type: candle_snapshot`.
  async candleSnapshot(
    coin: string,
    interval: string,
    startTime?: number,
    endTime?: number,
    candleType?: CandleType,
  ): Promise<CandleSnapshot> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'candle_snapshot',
      coin,
      interval,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    if (candleType !== undefined) body.candle_type = candleType;
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

  // ── P2 wave-1 typed reads (order / history / spot-margin / earn / pm) ────

  /// `order_status` — single-order lifecycle lookup. Pass EXACTLY one of `oid`
  /// (u64) or `cloid` (`0x` + 32 hex). Returns a `status`-tagged union
  /// (`resting` / `triggered` / `filled` / `unknown`); resolution order is
  /// resting → triggered → filled.
  ///
  /// A `cloid`-only query resolves resting / triggered hits only — the fill
  /// ring is oid-keyed, so a cloid that hit no live order returns `unknown`.
  async orderStatus(query: {
    oid?: number | bigint;
    cloid?: string;
  }): Promise<OrderStatusInfo> {
    const hasOid = query.oid !== undefined;
    const hasCloid = query.cloid !== undefined;
    if (hasOid === hasCloid) {
      throw new TypeError(
        'orderStatus requires exactly one of `oid` or `cloid`',
      );
    }
    const body: { type: string; [k: string]: unknown } = {
      type: 'order_status',
    };
    if (hasOid) {
      const oid = query.oid as number | bigint;
      if (typeof oid === 'bigint') {
        // Fail LOUD rather than silently truncate an oid beyond the f64 safe
        // integer range (Number(bigint) would lose precision).
        if (oid > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError(
            `orderStatus oid ${oid} exceeds Number.MAX_SAFE_INTEGER; would lose precision`,
          );
        }
        body.oid = Number(oid);
      } else {
        body.oid = oid;
      }
    }
    if (hasCloid) body.cloid = query.cloid;
    return this.post<OrderStatusInfo>(body);
  }

  /// `historical_orders` — the account's past (executed) orders, keyed by
  /// `address` (0x). Optional `limit` caps the most-recent records (sent ONLY
  /// when provided). Newest first; statuses are `"filled"` only today.
  async historicalOrders(
    address: string,
    limit?: number,
  ): Promise<HistoricalOrders> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'historical_orders',
      address,
    };
    if (limit !== undefined) body.limit = limit;
    return this.post<HistoricalOrders>(body);
  }

  /// `user_funding` — per-account realized funding-payment history, keyed by
  /// `address` (0x). Optional `startTime` / `endTime` (ms) filter the window,
  /// sent as `start_time` / `end_time` ONLY when provided (and echoed back).
  async userFunding(
    address: string,
    startTime?: number,
    endTime?: number,
  ): Promise<UserFunding> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_funding',
      address,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<UserFunding>(body);
  }

  /// `user_ledger_updates` — per-account balance-ledger deltas (NODE kind),
  /// keyed by `address` (0x). Optional window bounds as above. The `updates`
  /// records are untyped (`unknown[]`) pending the retention-seam shape; for
  /// the gateway-served NORMALIZED union use `userNonFundingLedgerUpdates`.
  async userLedgerUpdates(
    address: string,
    startTime?: number,
    endTime?: number,
  ): Promise<UserLedgerUpdates> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_ledger_updates',
      address,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<UserLedgerUpdates>(body);
  }

  /// `user_non_funding_ledger_updates` — the GATEWAY-served normalized ledger
  /// union, keyed by `address` (0x). Optional window bounds as above. NOTE the
  /// response collection key is camelCase `ledgerUpdates`.
  async userNonFundingLedgerUpdates(
    address: string,
    startTime?: number,
    endTime?: number,
  ): Promise<UserNonFundingLedgerUpdates> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_non_funding_ledger_updates',
      address,
    };
    if (startTime !== undefined) body.start_time = startTime;
    if (endTime !== undefined) body.end_time = endTime;
    return this.post<UserNonFundingLedgerUpdates>(body);
  }

  /// `spot_margin_state` — every spot-margin position of one user.
  ///
  /// REQUEST KEY is `user` (0x hex), NOT `address` — the spot-margin read
  /// surface keys by `user`.
  async spotMarginState(user: string): Promise<SpotMarginState> {
    return this.post<SpotMarginState>({ type: 'spot_margin_state', user });
  }

  /// `earn_state` — every Earn lending pool. Pass the optional `user` (0x hex)
  /// to also get that user's per-pool `user_shares` / `user_value` (sent ONLY
  /// when provided).
  async earnState(user?: string): Promise<EarnState> {
    const body: { type: string; [k: string]: unknown } = { type: 'earn_state' };
    if (user !== undefined) body.user = user;
    return this.post<EarnState>(body);
  }

  /// `pm_summary` — one account's portfolio-margin summary, keyed by `address`
  /// (0x). An unknown / non-enrolled address answers `enrolled:false` +
  /// zeroed figures. The `*_cents` fields are USD-CENTS-plane integer strings.
  async pmSummary(address: string): Promise<PmSummary> {
    return this.post<PmSummary>({ type: 'pm_summary', address });
  }

  /// `encode_action` — lower a wire action to its canonical core `Action` JSON.
  ///
  /// SDK-critical for `multi_sig`: the returned `action_json` STRING's exact
  /// bytes are the `inner_action_blob` every M-of-N member signs (cross-ref
  /// `native/multisig`). `action` is the familiar `{type, params}` wire form.
  async encodeAction(action: {
    type: string;
    [k: string]: unknown;
  }): Promise<EncodeAction> {
    return this.post<EncodeAction>({ type: 'encode_action', action });
  }

  // ── node snapshot reads ─────────────────────────────────────────────────

  /// `spot_meta` — spot pair universe + token registry.
  ///
  /// The standalone `spot_meta` /info type was REMOVED server-side (a bare
  /// request now 400s with `unknown info type`). This convenience wrapper
  /// fetches `markets_meta` (`kind: "spot"`) and unwraps its retained `spot`
  /// sub-object, which is the identical `{pairs, tokens}` shape — same data, a
  /// different endpoint. Prefer `marketsMeta()` when you also need the perp
  /// universe in the same round-trip.
  ///
  /// Each pair's `name` is derived as `{base}/{quote}` from the token
  /// registry; the numeric `id` is the compact `coin` label spot prints carry
  /// on the WS `trades` / `candles` / `fills` channels.
  async spotMeta(): Promise<SpotMeta> {
    const d = await this.post<{ spot: SpotMeta }>({
      type: 'markets_meta',
      kind: 'spot',
    });
    return d.spot;
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
  /// `fba_batch_state`, `rfq_open`, governance reads).
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
