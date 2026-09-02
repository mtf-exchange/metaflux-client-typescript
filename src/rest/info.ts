// MTF-native `/info` read API — typed request builders + envelope unwrap.
//
// Byte-for-byte mirror of the server's `/info` dispatcher and per-handler
// shapes (per the KB spec metaflux-knowledges/api/rest/info.md). Every request
// is a `POST /info` whose body is `{"type": "<discriminator>", ...params}` —
// snake_case field names, the exact convention the node decodes.
//
// ENVELOPE. Every successful response is `{"data": {...}}`, and the `type`
// discriminator rides INSIDE `data` next to the payload fields:
// `{"data": {"type": "<query>", ...payload}}`. A rejection answers
// `{"error": {"code", "message", "details"?}}` instead and is raised as a
// `MetaFluxApiError`. `post` validates the echoed `type` and returns the
// unwrapped `data` typed; the `raw<T>()` escape hatch returns it too.
//
// ONE QUESTION, ONE READ. A read that merely filtered or projected another was
// removed, and its ask became a PARAMETER on the read it duplicated:
// `market_info` is `markets` / `marketsMeta` with a `coin`, `margin_summary` is
// `accountState` with `detail: "margin"`, `recent_trades` / `trades_by_time`
// are `trades` with and without a window, and `user_fills_by_time` is
// `userFills` with a window.
//
// KEYING (consolidated surface). Market-scoped reads (`l2_book`, `trades`,
// `funding_history`, `markets`, `markets_meta`, `candle_snapshot`,
// `active_asset_data`) are keyed by `coin` — the market SYMBOL string (e.g.
// `"BTC"`). Account-scoped reads (`open_orders`, `user_fills`,
// `account_state`, every user read) are keyed by `address` (0x hex). The old
// numeric `market_id` / `asset_id` / `account_id` request params were REMOVED
// server-side; the number a SIGNER needs is `MarketStatic.signing_id`.
//
// Money magnitudes that can exceed JS `Number.MAX_SAFE_INTEGER` (2^53) are
// typed `string` in `../types/info/index.js` to match the node's decimal-string
// encoding; ids / counts stay `number`.

import { envelopeRequest } from './http.js';
import type {
  AccountOverview,
  AccountState,
  AccountMarginDetail,
  ClearinghouseState,
  ActiveAssetData,
  ApprovedBuilders,
  BridgeWithdrawalHistory,
  BuilderState,
  CandleSnapshot,
  CandleType,
  DelegatorRewards,
  EarnState,
  ExchangeStatus,
  FeeSchedule,
  FundingHistory,
  GossipRootIps,
  HistoricalOrders,
  L2Book,
  L2BookParams,
  Markets,
  MarketsMeta,
  Mip3ActiveBids,
  OpenOrders,
  OptionState,
  OptionSeriesRegistry,
  OrderStatusInfo,
  PerpDexs,
  ReferralState,
  RfqOpen,
  RfqUser,
  SpotDeployAuction,
  SpotMarginState,
  SpotMeta,
  StakingState,
  Trades,
  UserFills,
  UserFunding,
  UserLedgerUpdates,
  UserNonFundingLedgerUpdates,
  UserPositionHistory,
  UserRateLimit,
  UserTwaps,
  ValidatorL1Votes,
  ValidatorSummaries,
  VaultState,
  VaultSummaries,
} from '../types/info/index.js';

/// Response depth for `InfoApi.accountState`.
///
/// `"adl"` is NOT here any more: the position rows it widened moved to
/// `clearinghouseState`, which takes the same parameter. `account_state`
/// REFUSES it.
export type AccountDetail = 'full' | 'margin';

/// `/info` namespace handle. Each method POSTs a typed `{"type": ...}` body to
/// `POST <baseUrl>/info`, validates the `{data}` envelope, and returns the
/// unwrapped `data`.
///
/// No signing required — these are read-only queries. Construct via
/// `Client.info` or directly with a base URL.
export class InfoApi {
  constructor(private readonly baseUrl: string) {}

  // ── documented core reads ──────────────────────────────────────────────

  /// `account_state` — ONE coherent per-account snapshot, keyed by `address`
  /// (0x hex): the ACCOUNT truths at the top level, then one summary per LANE.
  ///
  /// `detail: "full"` (the default) returns the account scalars —
  /// `account_value`, `total_raw_usd`, `withdrawable`, `health`, `tier`,
  /// `abstraction`, `pm_net_value`, `position_mode` — plus the four lane keys
  /// `perp` / `spot` / `margin` / `option`. Every lane key is ALWAYS present
  /// and zeroed when the lane is empty, so no lane read needs a guard.
  ///
  /// The scalars are CROSS-LANE. Never sum the lanes to rebuild one: under
  /// USDC unification the same USDC backs more than one lane, so a sum
  /// double-counts it.
  ///
  /// The perp POSITION rows are NOT in this body. Read them with
  /// `clearinghouseState(address)`. Both bodies carry `height`, so a client can
  /// see when its detail lags its summary.
  ///
  /// `detail: "margin"` returns the margin scalars ALONE, which is the right
  /// ask for a frequent liquidation-health poll. It is a different shape, typed
  /// by `AccountMarginDetail`: it adds `cross_maintenance_margin_used`, it
  /// keeps the flat `total_margin_used` name, and it carries no lane keys.
  ///
  /// The node accepts a third value, `detail: "overview"`. It answers with the
  /// `AccountOverview` shape, which `AccountState` cannot describe, so
  /// `accountOverview()` posts it and types the answer.
  ///
  /// `detail: "adl"` is REFUSED. Pass it to `clearinghouseState` instead.
  ///
  /// `height` / `time` stamp the committed snapshot at every depth. The WS
  /// `account_state` frame carries the DEFAULT depth.
  async accountState(address: string, detail?: 'full'): Promise<AccountState>;
  async accountState(
    address: string,
    detail: 'margin',
  ): Promise<AccountMarginDetail>;
  async accountState(
    address: string,
    detail?: AccountDetail,
  ): Promise<AccountState | AccountMarginDetail> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'account_state',
      address,
    };
    if (detail !== undefined) body.detail = detail;
    return this.post<AccountState | AccountMarginDetail>(body);
  }

  /// `clearinghouse_state` — one account's open PERP POSITIONS, grouped by
  /// perp dex, for the account named by `address` (0x hex).
  ///
  /// This is the position detail that left the `account_state` body. The group
  /// key is the DEX NAME: the core dex is `""` and is always present, and a
  /// MIP-3 deployer dex uses the name its deployer registered, such as
  /// `"GRAD"`. That name is also the symbol namespace, so a position on dex
  /// `GRAD` has a coin like `"GRAD:000001SH"`. Join a group to its `perpDexs`
  /// row by `name`.
  ///
  /// The body carries NO equity, NO balances and NO health. Those are one
  /// commit-consistent set on `accountState`, and joining two frames to rebuild
  /// a health number can produce a figure that was never true. Compare `height`
  /// across the two bodies instead.
  ///
  /// `detail: "adl"` widens every row with `adl_lamps`. It is opt-in because
  /// each lamp ranks the position against every other position in that market,
  /// so ask for it only on a screen that shows the column. The WS
  /// `clearinghouse_state` frame never carries it: an always-on lamp would
  /// re-emit an account when a STRANGER's return-on-equity crossed a quartile.
  ///
  /// The node serves this read at HEAD. A node that predates the reshape
  /// answers `unknown info type`.
  async clearinghouseState(
    address: string,
    detail?: 'adl',
  ): Promise<ClearinghouseState> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'clearinghouse_state',
      address,
    };
    if (detail !== undefined) body.detail = detail;
    return this.post<ClearinghouseState>(body);
  }

  /// The account's full NON-TRADING state, keyed by `address` (0x hex): vault
  /// equities and vault summaries, staking, sub-accounts, the multisig signer
  /// set, API-wallet agents, and the derived role.
  ///
  /// It carries every facet the default `accountState` depth does not, in one
  /// round trip. Every sub-object is honest-empty rather than absent.
  ///
  /// The standalone `account_overview` `/info` type was REMOVED server-side.
  /// This posts `{type: 'account_state', detail: 'overview'}` and returns the
  /// same `AccountOverview` shape.
  async accountOverview(address: string): Promise<AccountOverview> {
    return this.post<AccountOverview>({
      type: 'account_state',
      address,
      detail: 'overview',
    });
  }

  /// `markets` — the DYNAMIC market universe: `{perp: MarketDynamic[], spot:
  /// SpotMeta}`. Perp records are keyed by `coin` and carry live price /
  /// funding / open interest / the 24h ticker.
  ///
  /// This read serves NO precision grid, NO leverage ladder and NO
  /// trade-control flag. Reading `sz_decimals`, `tick_size`, `open` or `close`
  /// off one of these rows yields `undefined`; call `marketsMeta()` and merge
  /// by `coin`.
  ///
  /// `coin` narrows the answer to ONE market. It narrows the same rows and does
  /// not change the shape, so a caller that wants one market pays one round
  /// trip and parses one shape. An unknown symbol answers 404.
  async markets(coin?: string): Promise<Markets> {
    const body: { type: string; [k: string]: unknown } = { type: 'markets' };
    if (coin !== undefined) body.coin = coin;
    return this.post<Markets>(body);
  }

  /// `markets_meta` — STATIC per-market metadata: the long-cacheable half of
  /// `markets` (precision grids `sz_decimals`/`tick_size`/`step_size`, leverage
  /// + `margin_tiers` ladder, `min_order`, trade-control flags, `mark_source`,
  /// the `signing_id` write handle and the `risk_override` governance
  /// override). Same `{perp, spot}` envelope as
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
  ///
  /// `coin` narrows the answer to ONE market; an unknown symbol answers 404.
  async marketsMeta(coin?: string): Promise<MarketsMeta> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'markets_meta',
    };
    if (coin !== undefined) body.coin = coin;
    return this.post<MarketsMeta>(body);
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
  ///
  /// Pass an `address` to also get that account's resolved rates in `user`.
  /// Read `user.products` for the product you are about to trade: `perp`,
  /// `spot`, `spot_margin` and `option` price apart, and the top-level
  /// `effective_*_bps` fields are the PERP ones.
  async feeSchedule(address?: string): Promise<FeeSchedule> {
    return this.post<FeeSchedule>(
      address === undefined
        ? { type: 'fee_schedule' }
        : { type: 'fee_schedule', address },
    );
  }

  // ── custody bridge reads ────────────────────────────────────────────────

  /// `bridge_withdrawal_history` — one account's pending bridge withdrawals AND the
  /// committed deployment rows, keyed by `address` (0x hex). `chain` restricts
  /// to `1` (Base) or `2` (Arbitrum); omit it to read every chain.
  ///
  /// Check `status` on each entry. `stranded_on_retired_domain` is TERMINAL and
  /// needs operator action, not a retry. `message_id` is the CURRENT-domain
  /// signing digest and it moves when governance rotates the deployment.
  ///
  /// `withdrawals_halted` and `configs` carry what the retired
  /// `bridge_chain_configs` read served. An address with no withdrawal still
  /// gets them, with an empty `entries`. Read the `effective_*` fields, not the
  /// raw ones: the raw values are 0-as-unset sentinels.
  ///
  /// Served by the historical archive, not by a validator: a validator prunes a
  /// released entry out of its outbox, so it could only ever answer "in flight
  /// right now". A deployment whose archive is unreachable answers `503` here.
  /// It NEVER answers an empty `entries`, because that would say the withdrawal
  /// is not in flight.
  async bridgeWithdrawalHistory(
    address: string,
    chain?: number,
  ): Promise<BridgeWithdrawalHistory> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'bridge_withdrawal_history',
      address,
    };
    if (chain !== undefined) body.chain = chain;
    return this.post<BridgeWithdrawalHistory>(body);
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

  /// `trades` — market-scoped public trade tape, keyed by `coin`.
  ///
  /// One read, two asks. Omit the window for the recent ring, newest first;
  /// `limit` then caps the most-recent records (absent = the full ring). Pass
  /// `startTime` / `endTime` (unix ms, sent as `start_time` / `end_time` ONLY
  /// when provided) to filter on each record's consensus `time`; a RANGED ask
  /// reaches the gateway archive and returns oldest first.
  async trades(
    coin: string,
    opts?: { limit?: number; startTime?: number; endTime?: number },
  ): Promise<Trades> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'trades',
      coin,
    };
    if (opts?.limit !== undefined) body.limit = opts.limit;
    if (opts?.startTime !== undefined) body.start_time = opts.startTime;
    if (opts?.endTime !== undefined) body.end_time = opts.endTime;
    return this.post<Trades>(body);
  }

  /// `user_fills` — account-scoped fill history, keyed by `address` (0x).
  ///
  /// One read, two asks. Omit the window for the recent records, newest first;
  /// `limit` then caps them. Pass `startTime` / `endTime` (unix ms, sent as
  /// `start_time` / `end_time` ONLY when provided) to filter on each record's
  /// consensus `time`, which returns them oldest first. The reply echoes both
  /// bounds, `null` for one you omitted.
  async userFills(
    address: string,
    opts?: { limit?: number; startTime?: number; endTime?: number },
  ): Promise<UserFills> {
    const body: { type: string; [k: string]: unknown } = {
      type: 'user_fills',
      address,
    };
    if (opts?.limit !== undefined) body.limit = opts.limit;
    if (opts?.startTime !== undefined) body.start_time = opts.startTime;
    if (opts?.endTime !== undefined) body.end_time = opts.endTime;
    return this.post<UserFills>(body);
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

  /// `mip3_active_bids` — MIP-3 permissionless perp-deploy auction snapshot.
  async mip3ActiveBids(): Promise<Mip3ActiveBids> {
    return this.post<Mip3ActiveBids>({ type: 'mip3_active_bids' });
  }

  /// `option_series` — every live option series, oldest first. No parameters.
  ///
  /// Each row carries the `signing_id` an RFQ action signs against, and the
  /// `escrow_per_unit` a writer locks. SIGN `signing_id`; never derive it —
  /// the encoding behind the number is internal to the node.
  ///
  /// READ `settle_asset` WITH `escrow_per_unit`. A put escrows the strike in
  /// USDC. A CALL ESCROWS ONE COIN of the underlying, so its `escrow_per_unit`
  /// is `'1'` and it is a coin, not dollars. A caller that reads it as dollars
  /// sizes a call writer's collateral wrong by the whole coin price.
  async optionSeries(): Promise<OptionSeriesRegistry> {
    return this.post<OptionSeriesRegistry>({ type: 'option_series' });
  }

  /// `option_state` — one account's open option legs, by `address`.
  ///
  /// RENAMED from `option_positions`. The old name is not an alias: it answers
  /// `unknown info type`, the same error a nonexistent read gets.
  ///
  /// Each row carries the series terms beside the position, so no second read
  /// is needed. An account party to no series answers `200` with an empty
  /// `positions` list.
  ///
  /// An option fill writes no ledger row of its own. Between the fill and
  /// expiry, this is the only read where a WRITER sees the escrow it locked and
  /// a HOLDER sees the units it owns.
  ///
  /// TWO PLANES ON ONE ROW: `long` / `short` are UNIT counts on the series size
  /// scale, already divided. `escrow` is MONEY, in the row's own
  /// `settle_asset` — USDC on a put, the underlying coin on a call. Both are
  /// typed `string` — only the field name separates them, and only
  /// `settle_asset` gives the escrow a unit. Never sum `escrow` over rows of
  /// both kinds.
  ///
  /// The `account_state` `option` lane carries the SUMMARY of these rows, and
  /// its one escrow number counts PUT legs only. Read this one for the legs
  /// themselves, and for a call's escrow.
  ///
  /// The node serves this read at HEAD. A node that predates the rename answers
  /// `unknown info type`.
  async optionState(address: string): Promise<OptionState> {
    return this.post<OptionState>({ type: 'option_state', address });
  }

  // ── P2 wave-1 typed reads (order / history / spot-margin / earn / pm) ────

  /// `order_status` — single-order lifecycle lookup. Pass EXACTLY one of `oid`
  /// or `cloid` (`0x` + 32 hex). Returns a `status`-tagged union (`resting` /
  /// `triggered` / `filled` / `canceled` / `cancel_rejected` / `rejected` /
  /// `unknown`); resolution order is resting → triggered → filled → terminal.
  ///
  /// `cancel_rejected` means the CANCEL request failed after the order left
  /// this node's live view. There is no `expired` token — the node never
  /// emits one.
  ///
  /// `filled` carries EVERY matching leg in `fills` plus `total_filled_sz`, so
  /// a partially filled order reports its whole executed size, not one leg.
  /// `unknown` means the order is outside this node's retention view — it is
  /// NOT proof the order never existed.
  ///
  /// `oid` takes a number, a `bigint` or a decimal-digit string. The request
  /// carries a `bigint` past `Number.MAX_SAFE_INTEGER` as a STRING, which the
  /// node accepts, rather than truncating it to a `Number`.
  async orderStatus(query: {
    oid?: number | bigint | string;
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
      const oid = query.oid as number | bigint | string;
      body.oid =
        typeof oid === 'bigint' && oid > BigInt(Number.MAX_SAFE_INTEGER)
          ? oid.toString()
          : typeof oid === 'bigint'
            ? Number(oid)
            : oid;
    }
    if (hasCloid) body.cloid = query.cloid;
    return this.post<OrderStatusInfo>(body);
  }

  /// `historical_orders` — the account's past (executed) orders, keyed by
  /// `address` (0x). Optional `limit` caps the most-recent records (sent ONLY
  /// when provided). Newest first; one record per order transition, so `oid`
  /// repeats.
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
  ///
  /// Spot token BALANCES are not here: `accountState(address).spot.balances`
  /// is the account's whole token ledger, USDC and spot tokens alike.
  async spotMeta(): Promise<SpotMeta> {
    const d = await this.post<{ spot: SpotMeta }>({
      type: 'markets_meta',
      kind: 'spot',
    });
    return d.spot;
  }

  /// `exchange_status` — global trading status. No parameters.
  async exchangeStatus(): Promise<ExchangeStatus> {
    return this.post<ExchangeStatus>({ type: 'exchange_status' });
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

  /// `vault_summaries` — every vault, in summary. No parameters.
  ///
  /// Each row names its `leader`. To list the vaults ONE address leads, filter
  /// the rows on `leader`; there is no per-leader read.
  async vaultSummaries(): Promise<VaultSummaries> {
    return this.post<VaultSummaries>({ type: 'vault_summaries' });
  }

  /// `user_rate_limit` — a user's action stats / rate-limit budget by `address`.
  async userRateLimit(address: string): Promise<UserRateLimit> {
    return this.post<UserRateLimit>({ type: 'user_rate_limit', address });
  }

  /// `spot_deploy_auction` — MIP-1 spot-pair-deploy gas-auction state. No
  /// params.
  ///
  /// UPGRADE NOTICE: the node answers this read under the older name
  /// `spot_deploy_state` until the release that ships the rename.
  async spotDeployAuction(): Promise<SpotDeployAuction> {
    return this.post<SpotDeployAuction>({ type: 'spot_deploy_auction' });
  }

  /// `validator_l1_votes` — current validator L1 votes. No parameters.
  async validatorL1Votes(): Promise<ValidatorL1Votes> {
    return this.post<ValidatorL1Votes>({ type: 'validator_l1_votes' });
  }

  /// `perp_dexs` — the perp DEX(es) plus the governed MIP-3 deploy and
  /// per-market limits, under `limits`. No parameters.
  async perpDexs(): Promise<PerpDexs> {
    return this.post<PerpDexs>({ type: 'perp_dexs' });
  }

  /// `validator_summaries` — per-validator snapshot. No parameters.
  async validatorSummaries(): Promise<ValidatorSummaries> {
    return this.post<ValidatorSummaries>({ type: 'validator_summaries' });
  }

  /// `gossip_root_ips` — the advertised peer roster. No params.
  async gossipRootIps(): Promise<GossipRootIps> {
    return this.post<GossipRootIps>({ type: 'gossip_root_ips' });
  }

  /// `rfq_open` — every open RFQ session, with its resting maker quotes. No
  /// parameters.
  ///
  /// A maker finds work here. `RfqSession.signing_id` is the number an
  /// `rfq_quote` signs in `market`, and a quote's INDEX in `quotes` is the
  /// `quote_idx` an accept names.
  ///
  /// Poll it — no WebSocket channel carries an RFQ event.
  async rfqOpen(): Promise<RfqOpen> {
    return this.post<RfqOpen>({ type: 'rfq_open' });
  }

  /// `rfq_user` — the RFQ sessions one account is party to, by `address`.
  ///
  /// A taker finds its own `rfq_id` here: `rfqRequest` answers with an
  /// admission ack, not a session id. Read `requested` after the request
  /// commits, then accept against `quotes` on that session.
  async rfqUser(address: string): Promise<RfqUser> {
    return this.post<RfqUser>({ type: 'rfq_user', address });
  }

  /// `referral_state` — an account's referral credit and bound referrer.
  ///
  /// Keyed by `user`, NOT `address` — this read and `builderState` are the two
  /// that name the account `user`.
  ///
  /// Read it BEFORE `claim_referral_rewards`: the claim answers with an
  /// admission ack and no amount, so this is the only view of the credit.
  async referralState(user: string): Promise<ReferralState> {
    return this.post<ReferralState>({ type: 'referral_state', user });
  }

  /// `builder_state` — a broker's accrued broker-code fee credit, keyed by
  /// `user` (see `referralState` on the key name).
  ///
  /// Read it BEFORE `claim_broker_rewards`, for the same reason.
  async builderState(user: string): Promise<BuilderState> {
    return this.post<BuilderState>({ type: 'builder_state', user });
  }

  /// `user_twaps` — an account's ACTIVE TWAP parents, by `address`.
  ///
  /// The live set only: a completed or cancelled parent leaves the tracker, so
  /// an empty list is not a history answer.
  async userTwaps(address: string): Promise<UserTwaps> {
    return this.post<UserTwaps>({ type: 'user_twaps', address });
  }

  /// `approved_builders` — every broker-fee grant an account has approved, by
  /// `address`.
  ///
  /// `max_fee_bps` is the CAP the account allows, not a rate the broker
  /// charges. An order whose `builder_fee` exceeds the row is refused, and an
  /// empty list means every broker-fee order this account signs is refused.
  async approvedBuilders(address: string): Promise<ApprovedBuilders> {
    return this.post<ApprovedBuilders>({ type: 'approved_builders', address });
  }

  /// `delegator_rewards` — an account's staking rewards, by `address`.
  ///
  /// Claim against `claimable_rewards`. It may exceed the sum of the per-
  /// validator rows, which carry no per-account carry.
  async delegatorRewards(address: string): Promise<DelegatorRewards> {
    return this.post<DelegatorRewards>({ type: 'delegator_rewards', address });
  }

  // ── escape hatches ──────────────────────────────────────────────────────

  /// Raw escape hatch — POST an arbitrary `{type, ...}` body to `/info`,
  /// validate the envelope, and return the unwrapped `data` typed. For request
  /// shapes the SDK doesn't yet model (e.g. `validator_votes`).
  ///
  /// It does NOT reach an operator-lane read. `mip3_deployer_oracle` and
  /// `fba_batch_state` are refused on the public API with the same error an
  /// unknown type gets. `node_info`, `block_info` and `protocol_metrics` are
  /// deleted outright — no lane serves them.
  async raw<T = unknown>(body: { type: string; [k: string]: unknown }): Promise<T> {
    return this.post<T>(body);
  }

  /// POST a typed body, check the `type` echoed inside `data` matches the
  /// request, and return `data`. The single place the envelope is peeled —
  /// every typed method routes through here.
  ///
  /// `data` keeps its `type` key, so a payload field stays exactly where it was.
  private async post<T>(body: { type: string; [k: string]: unknown }): Promise<T> {
    const data = await envelopeRequest<T>(this.baseUrl, '/info', {
      method: 'POST',
      json: body,
    });
    const echoed = (data as { type?: unknown } | null)?.type;
    if (echoed !== body.type) {
      throw new TypeError(
        `/info ${body.type}: response type mismatch — got '${String(echoed)}'`,
      );
    }
    return data;
  }
}
