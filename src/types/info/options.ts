// Option-lane response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/docs/api/rest/info.md.
// Field names are the exact snake_case keys the node emits inside
// `{type, data}.data`. Money magnitudes are typed `string`.
//
// TWO PUBLIC queries are typed here. `option_series` answers which series are
// live and which number to sign against. `option_state` answers what one
// account holds in them. `option_state` REPLACES the retired `option_positions`
// name — the old name is not an alias, it answers `unknown info type`.
//
// SIGN `signing_id`, DO NOT COMPUTE IT. The registry serves the number an RFQ
// action puts in its `market` field. There is no public formula, no base and no
// arithmetic that derives it: the encoding behind the number is internal to the
// node and may move. A client that derives it signs a market the chain may not
// resolve.
//
// READ `settle_asset` BEFORE YOU READ ANY ESCROW OR PAYOUT. It names the coin
// a series escrows and pays in. A put settles in USDC. A CALL SETTLES IN THE
// UNDERLYING: it escrows ONE COIN per unit and it pays that coin. So
// `escrow_per_unit`, `escrow` and every settlement amount are dollars on a put
// and COIN on a call. A caller that assumes dollars is wrong on every call
// series.
//
// THE DENOMINATION IS FORCED, NOT CHOSEN. A call pays `max(S* − K, 0)` in
// dollars, which has no upper bound, so no finite USDC escrow covers it. The
// same payoff read in the underlying is `max(1 − K/S*, 0)` coin per unit, which
// stays under one coin at every price. One coin therefore funds the writer in
// full at the fill. That is why an option position can never be liquidated.
//
// THE PREMIUM STAYS IN USDC ON BOTH LANES. `RfqQuoteEntry.price` and
// `RfqSession.limit_px` are dollars for a call as well as for a put. Only the
// escrow and the settlement payout follow `settle_asset`.
//
// A POSITION ROW CARRIES TWO PLANES. `long` and `short` are UNIT counts on the
// series size scale. The node already divides by `sz_decimals`, so `'2.5'` is
// two and a half whole units. `escrow` is MONEY, in `settle_asset`.
//
// Both planes are typed `string`, so a caller that reads `escrow` as a unit
// count, or `short` as an amount, gets a wrong number that still parses. The
// type cannot catch it. Read the field name.
//
// The registry carries no option price and no implied volatility, because the
// chain computes neither: the premium is what two accounts agree on in an RFQ.

/// Option kind. Standard European, and fully collateralized at the fill.
///
/// `S*` is the settlement price the chain reads from the underlying at expiry.
///
/// - `put` — payoff `max(K − S*, 0)` USDC per unit. The writer escrows `K`
///   USDC.
/// - `call` — payoff `max(1 − K/S*, 0)` COIN per unit. The writer escrows ONE
///   coin. See the file header for why a call is coin-denominated.
///
/// Two worked amounts on a $100,000 strike, per whole unit. At `S* = 80,000`
/// the put pays `100000 − 80000 = 20,000` USDC. At `S* = 125,000` the call pays
/// `1 − 100000/125000 = 0.2` coin.
///
/// THE THIRD KIND THIS SDK TYPED IS GONE. The chain cannot list it, no series
/// answers it, and nothing on the chain expresses a call spread any more. A
/// client that still matches on that token matches nothing.
export type OptionKind = 'put' | 'call';

/// One live option series.
export interface OptionSeries {
  /// The number an RFQ action puts in its `market` field. Served whole — never
  /// derive it. See the file header.
  signing_id: number;
  /// Symbol of the underlying market the settlement price comes from.
  underlying: string;
  /// `'put'` or `'call'`.
  kind: OptionKind;
  /// Strike `K`, whole-USDC decimal string. A strike is a DOLLAR price on both
  /// kinds, whatever `settle_asset` says.
  strike: string;
  /// Expiry (consensus ms). The first settlement attempt runs at this stamp.
  expiry: number;
  /// Size precision. An RFQ `size` of `10^sz_decimals` is ONE whole unit.
  sz_decimals: number;
  /// The coin this series escrows and pays in: `'USDC'` on a put, the
  /// underlying's token name (`'BTC'`) on a call.
  ///
  /// IT IS THE UNIT OF `escrow_per_unit` AND OF EVERY PAYOUT. Read it, do not
  /// infer it from `underlying`: the label comes from the spot-token registry,
  /// and the chain refuses to list a call on an underlying that has no spot
  /// token.
  settle_asset: string;
  /// What a WRITER locks per whole unit, decimal string IN `settle_asset`: the
  /// strike in USDC on a put, `'1'` — one coin — on a call.
  ///
  /// A call's lock is one coin at every strike, so this row never grows with
  /// `strike`. Read it as dollars and a call writer sizes its collateral by the
  /// coin price, which is the whole error.
  escrow_per_unit: string;
}

/// `option_series` — the live option series registry.
export interface OptionSeriesRegistry {
  /// One row per live series, oldest series first. Empty when none is live: a
  /// settled or expired series LEAVES the registry, and the RFQ actions then
  /// refuse its id.
  series: OptionSeries[];
}

/// One account's open leg in one option series.
///
/// The row mixes two planes: `long` / `short` are UNIT counts and `escrow` is
/// money in `settle_asset`. See the file header.
export interface OptionPosition {
  /// The number an RFQ action puts in its `market` field. Served whole — never
  /// derive it.
  signing_id: number;
  /// Symbol of the underlying market the settlement price comes from.
  underlying: string;
  /// `'put'` or `'call'`.
  kind: OptionKind;
  /// Strike `K`, whole-USDC decimal string.
  strike: string;
  /// Expiry (consensus ms).
  expiry: number;
  /// Units HELD, on the series size scale. Already whole units, NOT money.
  long: string;
  /// Units WRITTEN, on the series size scale. Already whole units, NOT money.
  short: string;
  /// The coin this series escrows and pays in — `'USDC'` on a put, the
  /// underlying's token name on a call. The unit of `escrow`.
  settle_asset: string;
  /// What this account has locked in the series pot, decimal string IN
  /// `settle_asset`. MONEY, not a unit count. It is what the writer takes back
  /// if the series settles worthless.
  ///
  /// NEVER SUM THIS ACROSS ROWS. A call leg is coin and a put leg is dollars,
  /// so a total over both kinds adds coins to dollars.
  escrow: string;
}

/// `option_state` — one account's open option legs.
///
/// A row carries no `sz_decimals` and no `escrow_per_unit`. Those are
/// series-wide, on `OptionSeries`.
///
/// One of `long` / `short` is always `'0'`. A fill consumes the opposite leg
/// before it opens a new one, so a row is either a holding or a written
/// position, never both.
///
/// The `account_state` `option` lane carries the SUMMARY of these rows — escrow,
/// leg count, nearest expiry. It is a different body from a different builder;
/// do not read one as the other. Its `escrow` is ONE USDC number, so it counts
/// PUT legs only. Per-series denominations are here.
///
/// The node serves this read at HEAD. A node that predates the rename answers
/// `unknown info type`, and so does the retired `option_positions` name.
export interface OptionState {
  /// The account the rows belong to, `0x` hex.
  address: string;
  /// One row per open leg. Empty when the account is party to no series.
  positions: OptionPosition[];
  /// Committed block height of the snapshot. The retired `option_positions`
  /// read carried no stamp.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
}

// ── RFQ session reads ───────────────────────────────────────────────────────
//
// `rfq_open` and `rfq_user` are PUBLIC reads. They are what makes the RFQ lane
// round-trip: a taker learns its own `rfq_id` from `rfq_user`, and a maker finds
// a request to quote on from `rfq_open`. Without them a caller can post a
// request and can never complete an accept.
//
// POLL THEM. No WebSocket channel carries an RFQ event.
//
// TWO SIDE PLANES. These reads answer `"B"` / `"A"`, the same tokens as
// `user_fills` and `trades`. The RFQ ACTIONS sign `"Bid"` / `"Ask"` (`CoreSide`).
// Never feed a read token straight into an action payload.

/// One maker quote resting on an RFQ session.
///
/// ITS POSITION IN `RfqSession.quotes` IS THE `quote_idx` AN ACCEPT NAMES. The
/// row carries no id of its own, so read the array index — and re-read the
/// session immediately before accepting, because a quote that expires or is
/// replaced shifts every later index.
export interface RfqQuoteEntry {
  /// Quoting maker, 0x hex.
  maker: string;
  /// The maker's self-trade-prevention group, or `null` when it set none.
  maker_stp_group: number | null;
  /// Quoted premium per unit, whole-USDC decimal string. USDC ON BOTH KINDS —
  /// the premium does NOT follow the series `settle_asset`.
  price: string;
  /// Largest size this maker will fill, on the series size scale.
  max_size: string;
  /// The quote expires at this consensus timestamp (ms).
  valid_until: number;
  /// When the maker posted the quote (consensus ms).
  submitted_at: number;
}

/// One open RFQ session with its resting maker quotes.
export interface RfqSession {
  /// Session id — the `rfq_id` a quote or an accept names.
  rfq_id: number;
  /// The option series this session clears, as the number an action SIGNS in
  /// its `market` field. RFQ is options-only; never derive this number.
  signing_id: number;
  /// Symbol of the series underlying, or `null` when the series is gone.
  underlying: string | null;
  /// Taker side, `"B"` (bid) or `"A"` (ask) — the READ plane, not `CoreSide`.
  side: 'B' | 'A';
  /// Requested size, on the series size scale.
  sz: string;
  /// The taker that opened the session, 0x hex. Only this account can accept.
  requester: string;
  /// The taker's self-trade-prevention group, or `null`.
  requester_stp_group: number | null;
  /// The session stops accepting at this consensus timestamp (ms).
  expiry: number;
  /// Worst premium the taker will pay, whole-USDC decimal string, or `null`
  /// when the request set no limit. USDC on both kinds, like `price`.
  limit_px: string | null;
  /// When the taker opened the session (consensus ms).
  created_at: number;
  /// Resting maker quotes, in `quote_idx` order.
  quotes: RfqQuoteEntry[];
}

/// `rfq_open` — every open RFQ session, with quotes. No parameters.
export interface RfqOpen {
  /// Open sessions. Empty when none rest.
  rfqs: RfqSession[];
}

/// `rfq_user` — the RFQ sessions one account is party to, keyed by `address`.
///
/// Both lists are empty for an account that is party to nothing; that is a
/// `200`, not a `404`.
export interface RfqUser {
  /// Echo of the requested account, 0x hex.
  address: string;
  /// Sessions this account opened as the taker.
  requested: RfqSession[];
  /// Sessions this account has quoted on as a maker.
  quoted: RfqSession[];
}
