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

/// Account liquidation tier — see `concepts/tiered-liquidation.md`.
export type Tier = 'Safe' | 'T0' | 'T1' | 'T2' | 'T3';

/// Per-position / per-asset margin mode label (lowercase wire form).
export type MarginMode = 'cross' | 'isolated' | 'strict_iso';

/// Account margin abstraction class: `"unified"` (default cross-collateral
/// account), `"standard"` (per-product reservations, set with
/// `user_set_abstraction`) or `"portfolio"` (portfolio-margin enrolled).
/// Replaces the old account-level `pm_enabled` boolean — derive PM enrollment as
/// `abstraction === 'portfolio'`.
export type Abstraction = 'unified' | 'standard' | 'portfolio';

/// One open position inside a `ClearinghouseState`.
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
  /// ADL queue indicator, `0` to `4` lamps. Served ONLY at `detail: "adl"`;
  /// absent at every other depth and on the WS frame.
  ///
  /// More lamps = sooner in the auto-deleveraging queue. It is a RANKING of
  /// this seat against the other seats on the same side, NOT a probability:
  /// four lamps with nobody being liquidated on the other side still means
  /// nothing happens. Never render it as a risk percentage.
  ///
  /// `0` is a real answer and is not "unknown". Zero says the position is not
  /// in the queue at all, which is the honest answer for a position ADL cannot
  /// structurally reach — no committed mark, no profit, no cost basis, or
  /// nobody on the opposite side to be deleveraged against. That last case
  /// includes a hedge account whose only opposing leg is its OWN, because ADL
  /// never nets an account against itself.
  adl_lamps?: number;
}

/// The positions of one perp dex inside
/// `ClearinghouseState.clearinghouse_state`. The object wraps `positions` so
/// the node can add per-dex fields later.
export interface DexPositions {
  /// Open positions on that dex.
  positions: AccountPosition[];
}

/// One token balance row of `account_state.spot.balances` — the account's WHOLE
/// token ledger, the unified USDC pool in row 0 and every spot token after it.
///
/// `total - hold` is NOT the spendable amount. `hold` counts spot order escrow
/// only: USDC that margins an open perpetual position stays in `total` and
/// never enters `hold`. Read `AccountState.withdrawable` for the budget.
export interface TokenBalance {
  /// Token symbol (e.g. `"USDC"`).
  name: string;
  /// The uint32 to put in the `token` field of a signed `spotSend`, and in
  /// `asset` of an `earnDeposit`. It has no other meaning: every row is keyed
  /// and joined by `name`.
  signing_id: number;
  /// Total balance (spendable + hold), whole-token decimal string.
  total: string;
  /// Amount reserved by resting spot orders, whole-token decimal string.
  hold: string;
  /// Weighted-average acquisition cost, whole USDC PER WHOLE TOKEN. A price,
  /// not a total: `(mark_px - avg_entry_px) * total` is the unrealized spot
  /// PnL. `total` includes the part held behind resting orders, so multiply by
  /// the quantity you mean rather than one the server picked for you.
  ///
  /// `null` means UNKNOWN, never zero. The chain rolls the basis on spot BUYS
  /// only — a sell keeps the standing per-unit average, and a deposit (bridge
  /// credit, Core-EVM credit, spot transfer, governance adjustment) writes no
  /// basis at all. Render nothing rather than a PnL against a `null` basis:
  /// that error is the whole notional reported as gain.
  ///
  /// The USDC row always reads `null` — a cost basis on the quote asset in
  /// terms of itself has no meaning.
  avg_entry_px?: string | null;
}

/// The `perp` lane summary inside an `AccountState`. ALWAYS present; every
/// field reads `"0"` when the account holds no perp leg.
///
/// The scope is the account's CROSS legs. An isolated leg carries its own
/// margin bucket and liquidates on that bucket alone, so it is not counted
/// here. Read the position row's own `margin` / `maint_margin` for an isolated
/// leg.
export interface AccountPerpLane {
  /// Initial margin the perp lane holds, whole-USDC decimal string. The flat
  /// body called this `total_margin_used`.
  init_margin: string;
  /// Mark notional of the CROSS legs, whole-USDC decimal string. An isolated
  /// leg is EXCLUDED, so this is not the account's whole exposure.
  total_ntl_pos: string;
  /// Portfolio-margin maintenance requirement, whole-USDC decimal string.
  /// `"0"` when the account is not PM-enrolled, so gate the MEANING on
  /// `abstraction === 'portfolio'` rather than on the value.
  pm_maint_margin: string;
  /// Portfolio-margin concentration penalty, whole-USDC decimal string. Same
  /// presence rule as `pm_maint_margin`.
  pm_concentration_penalty: string;
}

/// The `spot` lane summary — the account's WHOLE token ledger. ALWAYS present.
///
/// A spot balance IS the spot position, so no detail read splits off the way
/// the perp positions do.
export interface AccountSpotLane {
  /// One row per token, USDC first. NEVER an empty array: the node emits the
  /// USDC row unconditionally, reading `total: "0"` for an account that holds
  /// nothing. An empty array is a shape no real account returns, so treat one
  /// as a placeholder rather than as an empty ledger.
  balances: TokenBalance[];
}

/// The `margin` lane summary — the spot-margin lane folded to three numbers.
/// ALWAYS present, zeroed for an account with no margin position.
///
/// `base_held` does NOT fold in. It is per-pair BASE units with no common unit,
/// so read `spotMarginState(user)` for it. That detail read accrues debt
/// through the same path this summary uses, so the two cannot disagree.
export interface AccountMarginLane {
  /// Collateral posted across every spot-margin pair, whole-USDC decimal
  /// string. Every spot pair quotes in USDC, so the pairs are addable.
  collateral: string;
  /// Accrued debt across every pair, whole-USDC decimal string.
  debt: string;
  /// How many spot-margin pairs the account holds. A NUMBER, not a decimal
  /// string — it is a count, not money.
  pairs: number;
}

/// The `option` lane summary — what the account locked as an option WRITER,
/// and when its nearest leg expires. ALWAYS present, zeroed for an account
/// party to no series.
///
/// Read `optionState(address)` for the per-series legs.
export interface AccountOptionLane {
  /// USDC locked as writer escrow, decimal string. MONEY, not a unit count.
  ///
  /// PUT LEGS ONLY. This is one USDC number, and a CALL escrows the underlying
  /// coin, so a call leg cannot be added to it without summing coins into
  /// dollars. `legs` still counts every leg, so `escrow: '0'` with `legs: 3`
  /// is a normal account that writes calls. Read `optionState(address)` for a
  /// call's escrow and the coin it is in.
  escrow: string;
  /// How many open legs the account holds. A NUMBER, not a decimal string.
  legs: number;
  /// Nearest leg expiry (consensus ms). ABSENT when `legs` is `0`: a zero
  /// timestamp reads as 1970, so the node omits the key instead of serving one.
  next_expiry?: number;
}

/// `account_state` — ONE coherent per-account snapshot: the ACCOUNT truths at
/// the top level, then one summary per LANE.
///
/// The top-level scalars are CROSS-LANE figures. `account_value` folds perp AND
/// spot-margin unrealised PnL, `withdrawable` subtracts BOTH lanes' held initial
/// margin, and `health` / `tier` derive from those. Never read one as a
/// perp-only number, and never sum the lanes to rebuild one — under USDC
/// unification the same USDC backs more than one lane, so a sum double-counts
/// it. `pm_net_value` is the same case: it reads like a perp figure and is a
/// WHOLE-ACCOUNT one, which is why it sits at the top level.
///
/// Every lane key is ALWAYS present, zeroed when the lane is empty, so
/// `state.perp.init_margin` needs no guard. The one exception is
/// `option.next_expiry`, which is absent when the option lane is empty.
///
/// The perp POSITION table LEFT this body. Read `clearinghouseState(address)`,
/// or subscribe to the `clearinghouse_state` channel. Both bodies carry
/// `height`, so a client can see when its detail lags its summary.
///
/// `detail: "margin"` answers the narrower `AccountMarginDetail` body.
/// `detail: "overview"` answers the non-trading facets as `AccountOverview`.
/// `detail: "adl"` is REFUSED here — the rows it widened moved to
/// `clearinghouseState`, which takes the same parameter.
export interface AccountState {
  /// Echo of the requested 0x address.
  address: string;
  /// Equity including unrealised PnL, whole-USDC decimal string. CROSS-LANE.
  account_value: string;
  /// Settled cash equity, whole-USDC decimal string. It EXCLUDES unrealised
  /// PnL, so a mark move alone never moves it. `account_value` is the same
  /// equity WITH that PnL counted.
  total_raw_usd: string;
  /// Cash the account can take out, decimal string, CLAMPED at zero.
  ///
  /// It is settled cash minus funding owed minus the initial margin BOTH lanes
  /// hold. It does NOT count unrealised profit, so a healthy account whose
  /// margin is funded by open profit reads `'0'` — that means "nothing to
  /// withdraw", not "broke". The chain's admission gate uses the raw signed
  /// figure, which can go negative; this read never does.
  withdrawable: string;
  /// `account_value - cross_maintenance_margin_used` (signed decimal string).
  /// Read the maintenance margin itself with `detail: "margin"`.
  health: string;
  /// Liquidation tier. A STRING, never a number.
  tier: Tier;
  /// Present and `true` ONLY when the risk engine DEFERS on this account: it
  /// holds a leg no risk path can price. The reported maintenance margin is
  /// then `0` for want of a price, NOT because the account carries no
  /// requirement — so `tier` and `health` are not solvency statements. A
  /// priceable account omits the key. The market-side twin is `px_stale`.
  health_deferred?: boolean;
  /// Margin abstraction class (`abstraction === 'portfolio'` = PM enrolled).
  abstraction: Abstraction;
  /// Portfolio-margin net account value, whole-USDC decimal string. Always
  /// present — `"0"` when the account is not PM-enrolled.
  ///
  /// TOP LEVEL, not under `perp`, and that placement is the contract. Its cash
  /// term is the whole unified pool, and under multi-collateral it also folds
  /// haircut-valued SPOT balances. It is the PM twin of `account_value`.
  pm_net_value: string;
  /// Position mode: `"one_way"` (single net position) or `"hedge"` (two-way).
  position_mode: 'one_way' | 'hedge';
  /// Perp lane summary. The position rows are on `clearinghouseState`.
  perp: AccountPerpLane;
  /// Spot lane — the whole token ledger.
  spot: AccountSpotLane;
  /// Spot-margin lane summary. The per-pair rows are on `spotMarginState`.
  margin: AccountMarginLane;
  /// Option lane summary. The per-series legs are on `optionState`.
  option: AccountOptionLane;
  /// Committed block height of the snapshot. Compare it across two reads to
  /// reject a stale snapshot.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
}

/// The `account_state` `detail: "margin"` body — the scalars ALONE, for a
/// frequent liquidation-health poll.
///
/// It is a DIFFERENT shape, not a thinner `AccountState`: it adds
/// `cross_maintenance_margin_used`, it keeps the flat `total_margin_used` name,
/// and it carries NO lane keys and no `position_mode`. The node skips the
/// position walk and the balance scan to serve it.
export interface AccountMarginDetail {
  /// Echo of the requested 0x address.
  address: string;
  /// Equity including unrealised PnL, whole-USDC decimal string.
  account_value: string;
  /// Settled cash equity, whole-USDC decimal string.
  total_raw_usd: string;
  /// Cash the account can take out, decimal string, CLAMPED at zero.
  withdrawable: string;
  /// Maintenance margin of the account's CROSS legs, whole-USDC decimal
  /// string. Served at THIS depth only; the full body drops it.
  ///
  /// The scope is CROSS. An isolated position carries its own margin bucket
  /// and liquidates on that bucket alone, so never size an isolated position
  /// from this number. Read the position row's `maint_margin` for that leg.
  cross_maintenance_margin_used: string;
  /// Initial margin requirement, whole-USDC decimal string. This depth KEEPS
  /// the flat name; the full body serves the same number as
  /// `perp.init_margin`.
  total_margin_used: string;
  /// `account_value - cross_maintenance_margin_used` (signed decimal string).
  health: string;
  /// Liquidation tier.
  tier: Tier;
  /// Present and `true` only when the risk engine defers on the account.
  health_deferred?: boolean;
  /// Margin abstraction class.
  abstraction: Abstraction;
  /// Committed block height of the snapshot.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
}

/// `clearinghouse_state` — one account's open PERP POSITIONS, grouped by dex.
///
/// This is the position detail that left the `account_state` body. It carries
/// NO equity, NO balances and NO health: those are one commit-consistent set on
/// `account_state`, and joining two frames to rebuild a health number can
/// produce a figure that was never true. Compare `height` across the two
/// bodies instead.
///
/// The node serves this read at HEAD. A node that predates the reshape answers
/// `unknown info type`.
export interface ClearinghouseState {
  /// Echo of the requested 0x address.
  address: string;
  /// Open positions grouped by perp dex, keyed by the DEX NAME. The core dex
  /// key is the empty string `""` and is ALWAYS present, so an empty account
  /// still has an anchor. A MIP-3 deployer dex uses the name its deployer
  /// registered, such as `"GRAD"`, which is also the symbol namespace of every
  /// coin in the group. Join to a `PerpDex` row by `name`.
  clearinghouse_state: Record<string, DexPositions>;
  /// Committed block height of the snapshot.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
}

/// Per-market funding parameters on a market row.
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

/// One margin-tier band inside `MarketStatic.margin_tiers`.
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
/// bare `0x` string. `null`/omitted when the token binds nothing.
export interface TokenEvmContract {
  /// `0x` EVM contract address BOUND to the token. This is the address a
  /// Core-to-EVM transfer credits. A contract a deployer merely declared at
  /// `register_token` is never served here.
  address: string;
  /// Deployer-declared offset, signed. It does NOT change a credit: a credit
  /// lands in the token's sibling `wei_decimals`. Treat this as metadata.
  evm_extra_wei_decimals: number;
  /// Binding-registry variant tag, folded in from the retired
  /// `evm_contract_bindings` read. Absent for the built-in USDC binding, which
  /// the credit path answers with no registry row behind it.
  variant?: number;
}

/// The registered underlying token of a perp market, surfaced inline on a
/// `MarketStatic` (the `markets_meta` perp rows) as the `token`
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
  /// The uint32 to put in the EIP-712 `market` field when SIGNING an order for
  /// this market. It has no other meaning: every read keys by `coin`, so never
  /// sort, join or identify a market by this number.
  ///
  /// The signing type string is consensus-frozen at `uint32 market`, so a
  /// signer needs a number. Publishing it here keeps that number on the wire
  /// instead of making it knowledge the client carries out of band.
  signing_id: number;
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
  /// REMAINING open-interest headroom, whole base units as a decimal string.
  ///
  /// The node already subtracts live open interest from the cap, so do NOT
  /// rebuild it from `oi_cap` and `Markets.perp[].open_interest`. `null` means
  /// the market is UNCAPPED, and `"0"` means the cap is reached — the two look
  /// alike only if you read `null` as zero.
  max_market_order_ntl: string | null;
  /// The registered underlying token block, when the perp has one. OMITTED
  /// (absent) when there is no registered underlying token — never `null`.
  token?: PerpUnderlyingToken;
  /// The governance risk override in force on this market.
  ///
  /// `null` means NO override exists. An OBJECT with every field absent means
  /// an override record exists and overrides nothing — a different fact, and
  /// the one that used to be invisible.
  risk_override?: RiskOverride | null;
}

/// A governance risk override on one market, from `MarketStatic.risk_override`.
///
/// Every field is optional: an override that moves only `max_leverage` carries
/// only `max_leverage`. An absent field is NOT overridden — the market's
/// default (the sibling field on the same `MarketStatic`) applies.
export interface RiskOverride {
  /// Overridden maximum leverage multiple.
  max_leverage?: number;
  /// Overridden maintenance margin ratio, decimal bps string.
  maint_margin_ratio?: string;
  /// Overridden initial margin ratio, decimal bps string.
  init_margin_ratio?: string;
  /// Overridden per-period funding-rate cap, decimal fraction string.
  funding_rate_cap?: string;
  /// Overridden open-interest cap, whole base units as a decimal string.
  oi_cap?: string;
}

/// The DYNAMIC half of a market — the `markets` perp row.
///
/// Live price, funding, open interest and the 24h ticker. It carries NO
/// precision grid, NO leverage ladder and NO trade-control flag: reading
/// `sz_decimals`, `tick_size`, `open` or `close` off this row yields
/// `undefined`. Read `MarketsMeta.perp` for those and merge by `coin`.
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
  /** Leader performance fee, whole basis points as a decimal string. */
  performance_fee_bps: string;
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
  /// What funds the staking reward. Absent on a node that predates the field.
  reward_pool?: RewardPool;
}

/// What funds the staking reward — the committed inputs, and NO rate.
///
/// The emission era is over: rewards come from fees, not from a curve, so there
/// is no annual rate to publish and none to derive. The pending pool is a
/// snapshot of accrued fees, and it depends on volume that has not happened
/// yet. A plausible-looking wrong APR is worse than an honest absence.
export interface RewardPool {
  /// Total staked MTF across the chain, decimal string.
  total_stake: string;
  /// Fees accrued to the validator pool and not yet distributed, whole USDC.
  pending_validator_pool_usdc: string;
  /// Always `"fee_funded_on_book_buy"` — a constant that tells a fee-funded
  /// chain from an emission-funded one without inferring it.
  reward_source: string;
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
///
/// THIS READ CARRIES NO BUILDER REBATE. There is no schedule-wide rebate rate:
/// a broker's rate is the `builder_fee` it sets on each order, and the account
/// caps it with `approved_builders[].max_fee_bps`. Read that cap, not a field
/// here.
export interface FeeSchedule {
  /// Top-level base maker fee, decimal bps string. May be absent — fall back
  /// to `tiers[0].maker_bps` when `undefined`.
  maker_bps?: string;
  /// Top-level base taker fee, decimal bps string. See `maker_bps`.
  taker_bps?: string;
  /// Volume-tier ladder (authoritative carrier of maker/taker).
  tiers: FeeTier[];
  /// Burn fraction of the non-referrer remainder, decimal fraction string in
  /// `[0, 1]` (NOT bps).
  burn_ratio: string;
  /// Referrer share of the base taker take, decimal bps string.
  referrer_share_bps: string;
  /// The day the POOLED volume counter stops buying a discount and each product
  /// reads only its own volume. `0` = not armed yet. A server that predates
  /// per-product fees omits it.
  pooled_volume_sunset_day?: number;
  /// The same instant in milliseconds, as a decimal string. `"0"` = not armed.
  pooled_volume_sunset_ms?: string;
  /// `true` while pooled volume still feeds a tier. On the sunset day this goes
  /// false and a tier resting on cross-product volume DROPS.
  pooled_volume_counts?: boolean;
  /// One account's RESOLVED rates. Present only when the request carried an
  /// `address` (see `Info.feeSchedule(address)`); absent on the ladder-only read.
  user?: FeeScheduleUser;
}

/// One product's resolved rates inside a `FeeScheduleUser`.
///
/// The four products price APART: each carries its own ladder, its own base
/// rates and its own 30-day counters. Read the row for the product you are about
/// to trade — the top-level `FeeScheduleUser` rates are the PERP ones.
export interface ProductFeeRow {
  /// `"perp"`, `"spot"`, `"spot_margin"` or `"option"`.
  product: string;
  /// The rate a fill on this product charges the taker, staking discount
  /// applied. Decimal bps string.
  ///
  /// ABSENT on the `option` row, which does not price on a volume ladder — read
  /// `option_taker_bps` there instead.
  taker_bps?: string;
  /// The rate a fill on this product charges the maker, rebate subtracted.
  /// Decimal bps string; NEGATIVE means a credit paid to the maker.
  ///
  /// ABSENT on a product with NO maker leg. A maker rests on the shared spot
  /// book and never carries a lane, so it is always priced as `spot` — which
  /// leaves `spot_margin` and `option` with a taker leg only.
  maker_bps?: string;
  /// The trailing 30-day taker volume THIS product's tier reads.
  /// ABSENT on the `option` row: an option does not price on a volume ladder.
  taker_volume_30d?: string;
  /// The trailing 30-day maker volume THIS product's maker tier reads.
  /// ABSENT on a product with no maker leg — see `maker_bps`.
  maker_volume_30d?: string;
  /// OPTION ROW ONLY. The rate charged on the STRIKE FACE — `strike × units` —
  /// on BOTH kinds. Decimal bps string.
  ///
  /// That face is the put's maximum payout exactly. A call's maximum payout is
  /// one coin, which has no USDC figure the chain can read without a price, so
  /// the strike face prices both lanes. The fee itself is USDC on both.
  ///
  /// The fee is the SMALLER of this term and `option_premium_cap_ppm` of the
  /// premium. Both start unset, which charges nothing.
  option_taker_bps?: string;
  /// OPTION ROW ONLY. The fee ceiling as a fraction of the premium, in ppm.
  option_premium_cap_ppm?: number;
}

/// One account's resolved fee position, returned by `Info.feeSchedule(address)`.
///
/// Only the taker of a fill carries a product. A maker rests on the shared spot
/// book, so a maker is always priced as `spot` whichever lane crosses it.
export interface FeeScheduleUser {
  /// The resolved account.
  address: string;
  /// POOLED trailing 30-day taker volume, every product together.
  taker_volume_30d: string;
  /// POOLED trailing 30-day maker volume.
  maker_volume_30d: string;
  /// The PERP base taker rate, before the discount. Decimal bps string.
  taker_bps: string;
  /// The PERP base maker rate, before the rebate. Decimal bps string.
  maker_bps: string;
  /// The PERP taker rate a fill charges, discount applied.
  effective_taker_bps: string;
  /// The PERP maker rate a fill charges, rebate subtracted.
  effective_maker_bps: string;
  /// Taker-only staking discount, per mille (`100` = 10%).
  staking_discount_permille: number;
  /// The PERP maker rebate, before it is subtracted. Decimal bps string.
  maker_rebate_bps: string;
  /// Per-product resolved rates. A server that predates per-product fees sends
  /// no rows, so an absent field means "not served", NOT "no products".
  products?: ProductFeeRow[];
}

/// `referral_state` — one account's referral credit and the referrer it is bound
/// to. Keyed by `user` (0x hex), NOT by `address`: this read and `builder_state`
/// are the two `/info` reads that name the account `user`.
///
/// READ THE CREDIT BEFORE YOU CLAIM IT. `claim_referral_rewards` returns an
/// admission ack and no amount, so this is the only place the pending credit is
/// visible.
///
/// The referral graph is address-based and ONE-DIRECTIONAL. There is no referral
/// code and no reverse map, so this read cannot list the traders one referrer
/// brought in — it answers only for the account you name.
export interface ReferralState {
  /// Echo of the requested account, 0x hex.
  user: string;
  /// Referral fee credit accrued and not yet claimed, whole-USDC decimal
  /// string. `"0"` when nothing is pending.
  claimable_rewards: string;
  /// The referrer this account bound with `set_referrer`, 0x hex. `null` when
  /// the account never bound one — binding is one-time.
  referrer: string | null;
}

/// `builder_state` — one broker's accrued broker-code fee credit. Keyed by
/// `user` (0x hex), like `referral_state`.
///
/// READ THE CREDIT BEFORE YOU CLAIM IT. `claim_broker_rewards` returns an
/// admission ack and no amount.
///
/// It carries NO rate. What a broker may charge is the per-order `builder_fee`,
/// bounded by the payer's `approved_builders[].max_fee_bps`.
export interface BuilderState {
  /// Echo of the requested broker account, 0x hex.
  user: string;
  /// Broker fee credit accrued and not yet claimed, whole-USDC decimal string.
  claimable_rewards: string;
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
  /// Pool token symbol — the same row shape `account_state.spot.balances`
  /// carries.
  name: string;
  /// The uint32 to put in the `asset` field of a signed `earnDeposit` /
  /// `earnWithdraw`. It has no other meaning: every row is keyed by `name`.
  signing_id: number;
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

