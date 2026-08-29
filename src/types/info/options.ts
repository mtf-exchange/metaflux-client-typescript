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
// THE ESCROW IS WHAT A WRITER LOCKS. On a `capped_call`, `escrow_per_unit` is
// `cap − strike`, not `strike`. A $100,000 strike capped at $130,000 locks
// $30,000 per unit. Reading `strike` as the lock overstates it by the whole
// strike.
//
// A POSITION ROW CARRIES TWO PLANES. `long` and `short` are UNIT counts on the
// series size scale. The node already divides by `sz_decimals`, so `'2.5'` is
// two and a half whole units. `escrow` is MONEY: a decimal USDC string.
//
// Both planes are typed `string`, so a caller that reads `escrow` as a unit
// count, or `short` as a dollar figure, gets a wrong number that still parses.
// The type cannot catch it. Read the field name.
//
// The registry carries no option price and no implied volatility, because the
// chain computes neither: the premium is what two accounts agree on in an RFQ.

/// Option kind. A call is always CAPPED: an uncapped call has no finite worst
/// case, so cash cannot fully collateralize it.
///
/// - `put` — payoff `max(K − S, 0)` per unit. The writer locks the strike.
/// - `capped_call` — payoff `min(max(S − K, 0), C − K)` per unit. The writer
///   locks `C − K`.
export type OptionKind = 'put' | 'capped_call';

/// One live option series.
export interface OptionSeries {
  /// The number an RFQ action puts in its `market` field. Served whole — never
  /// derive it. See the file header.
  signing_id: number;
  /// Symbol of the underlying market the settlement price comes from.
  underlying: string;
  /// Put, or capped call.
  kind: OptionKind;
  /// Strike `K`, whole-USDC decimal string.
  strike: string;
  /// Cap `C`, whole-USDC decimal string. ABSENT on a put — the node omits the
  /// key.
  cap?: string;
  /// Expiry (consensus ms). The first settlement attempt runs at this stamp.
  expiry: number;
  /// Size precision. An RFQ `size` of `10^sz_decimals` is ONE whole unit.
  sz_decimals: number;
  /// What a WRITER locks per whole unit, whole-USDC decimal string. On a
  /// `capped_call` this is `cap − strike`.
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
/// USDC. See the file header.
export interface OptionPosition {
  /// The number an RFQ action puts in its `market` field. Served whole — never
  /// derive it.
  signing_id: number;
  /// Symbol of the underlying market the settlement price comes from.
  underlying: string;
  /// Put, or capped call.
  kind: OptionKind;
  /// Strike `K`, whole-USDC decimal string.
  strike: string;
  /// Expiry (consensus ms).
  expiry: number;
  /// Units HELD, on the series size scale. Already whole units, NOT money.
  long: string;
  /// Units WRITTEN, on the series size scale. Already whole units, NOT money.
  short: string;
  /// USDC this account has locked in the series pot. MONEY, not a unit count.
  /// It is what the writer takes back if the series settles worthless.
  escrow: string;
}

/// `option_state` — one account's open option legs.
///
/// A row carries no `cap`, no `sz_decimals` and no `escrow_per_unit`. Those are
/// series-wide, on `OptionSeries`.
///
/// One of `long` / `short` is always `'0'`. A fill consumes the opposite leg
/// before it opens a new one, so a row is either a holding or a written
/// position, never both.
///
/// The `account_state` `option` lane carries the SUMMARY of these rows — total
/// escrow, leg count, nearest expiry. It is a different body from a different
/// builder; do not read one as the other.
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
  /// Quoted premium per unit, whole-USDC decimal string.
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
  /// when the request set no limit.
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
