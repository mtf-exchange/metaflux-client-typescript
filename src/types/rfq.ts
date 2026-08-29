// MTF-native RFQ (Request-for-Quote) action payload types.
//
// These ride the W1 typed (the typed `/exchange`) path: the SDK signs the
// node's frozen `RfqRequest` / `RfqAccept` EIP-712 structs and POSTs the
// canonical `{"type":...,"params":{...}}` envelope the typed-only `/exchange`
// admits. The typed encoding is the single source of truth (`../native/typed`);
// these interfaces only describe the snake_case payload the typed specs read.

/// Order side as the **core** RFQ / FBA action handlers deserialize it:
/// PascalCase `"Bid"` / `"Ask"`.
///
/// Deliberately distinct from the snake_case `NativeSide` (`"bid"`/`"ask"`)
/// used by the perp/spot order builders: the node's `core_state::Side` enum
/// carries no `#[serde(rename_all)]`, so the `rfq_request` / `fba_submit`
/// payloads expect PascalCase tokens. The typed `side-u8` field POSTs this
/// PascalCase NAME and signs the `uint8` code (Bid=0, Ask=1).
export type CoreSide = 'Bid' | 'Ask';

/// `rfq_request` — a taker opens an RFQ session asking MMs to quote. Mirrors the
/// node's frozen `RfqRequest` typed struct.
///
/// `market` is the `signing_id` of a LIVE option series, from
/// `InfoApi.optionSeries`. RFQ clears options and nothing else, and the number
/// is served whole — never derive it.
///
/// AN `Ask` REQUEST WRITES THE SERIES, so it must fund the escrow. On a CALL
/// series the escrow is ONE COIN of the underlying per unit, taken from the
/// SPOT balance, not from cross collateral. Hold the coin first: a request that
/// carries a `limit_px` is pre-checked and refused with
/// `insufficient underlying balance for the escrow`. The USDC premium the
/// writer receives cannot net a coin escrow — they are different assets.
///
/// PRICE IS USDC ON BOTH KINDS. `limit_px` is a dollar premium per unit for a
/// call as well as for a put — it does NOT follow the series `settle_asset`.
/// Only the escrow and the settlement payout do.
///
/// All numeric fields are RAW `u64` wire values (fixed-point lots / price), NOT
/// decimal-scaled — pass a `number` or `bigint`. `limit_px` and `stp_group` are
/// `Option<u64>`: the typed digest flattens each to a presence bool + a value
/// word, and the POST `params` carries the key ONLY when present (omit, or pass
/// `null`, to leave it absent).
///
/// To request AS a vault (operator path), pass `opts.owner` on
/// `Client.rfqRequest` — it binds the node's owner-carrying digest. The node
/// records the owner as the requester, and only that account can accept.
export interface RfqRequest {
  /// The `signing_id` of a live option series (`u32`), from
  /// `InfoApi.optionSeries`. Any other market is refused.
  market: number;
  /// Taker side — POSTs PascalCase (`"Bid"`/`"Ask"`), signs the uint8 code.
  side: CoreSide;
  /// Requested size (`u64`, `> 0`).
  size: number | bigint;
  /// Optional worst-acceptable price (`u64`). Omit or pass `null` when absent.
  limit_px?: number | bigint | null;
  /// Server-clock expiry (ms, `u64`). `0` lets the node default to `ts_ms + 5000`.
  expiry_ms: number | bigint;
  /// Optional STP group id (`u64`). Omit or pass `null` when absent.
  stp_group?: number | bigint | null;
}

/// `rfq_quote` — a maker posts a quote onto an open RFQ session. Mirrors the
/// node's frozen `RfqQuote` typed struct.
///
/// `price` is a USDC premium per unit on BOTH kinds. QUOTING THE ASK SIDE OF A
/// CALL MAKES YOU THE WRITER: hold one coin of the underlying per unit on the
/// spot ledger before the taker accepts, or the accept is refused with
/// `insufficient underlying balance for the escrow`.
///
/// All numeric fields are RAW `u64` wire values (fixed-point lots / price), NOT
/// decimal-scaled — pass a `number` or `bigint`. `stp_group` is `Option<u64>`:
/// the typed digest flattens it to a presence bool + a value word, and the POST
/// `params` carries the key ONLY when present (omit, or pass `null`, to leave it
/// absent). To quote AS a vault (operator path), pass `opts.owner` on
/// `Client.rfqQuote` — it binds the node's owner-carrying digest.
export interface RfqQuote {
  /// Parent RFQ session id (`u64`).
  rfq_id: number | bigint;
  /// Quote price (`u64`, fixed-point).
  price: number | bigint;
  /// Maximum size the maker will fill (`u64`).
  max_size: number | bigint;
  /// Server-clock quote expiry (ms, `u64`).
  valid_until_ms: number | bigint;
  /// Optional STP group id (`u64`). Omit or pass `null` when absent.
  stp_group?: number | bigint | null;
}

/// `rfq_accept` — a taker crosses against a specific resting quote. Mirrors the
/// node's frozen `RfqAccept` typed struct.
///
/// Pass the SAME `opts.owner` the request carried. The node admits an accept
/// only from the account it recorded as the requester.
export interface RfqAccept {
  /// Parent RFQ session id (`u64`).
  rfq_id: number | bigint;
  /// Index of the accepted quote in `RfqSession.quotes` (`u32`), from
  /// `InfoApi.rfqOpen` / `InfoApi.rfqUser`. Re-read the session first: an
  /// expired or replaced quote shifts every later index.
  quote_idx: number;
  /// Accepted size (`u64`, `<= min(request.size, quote.max_size)`).
  size: number | bigint;
}
