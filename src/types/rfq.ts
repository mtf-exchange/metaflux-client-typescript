// MTF-native RFQ (Request-for-Quote) action payload types.
//
// These ride the W1 typed (`sig_scheme:"typed"`) path: the SDK signs the
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
/// All numeric fields are RAW `u64` wire values (fixed-point lots / price), NOT
/// decimal-scaled — pass a `number` or `bigint`. `limit_px` and `stp_group` are
/// `Option<u64>`: the typed digest flattens each to a presence bool + a value
/// word, and the POST `params` carries the key ONLY when present (omit, or pass
/// `null`, to leave it absent).
export interface RfqRequest {
  /// Market to request a quote on (`u32`).
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

/// `rfq_accept` — a taker crosses against a specific resting quote. Mirrors the
/// node's frozen `RfqAccept` typed struct.
export interface RfqAccept {
  /// Parent RFQ session id (`u64`).
  rfq_id: number | bigint;
  /// Index of the accepted quote in the session's quote vector (`u32`).
  quote_idx: number;
  /// Accepted size (`u64`, `<= min(request.size, quote.max_size)`).
  size: number | bigint;
}
