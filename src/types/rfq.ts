// MTF-native RFQ (Request-for-Quote) action payload types.
//
// Forward-compat: the node recognizes the `rfq_request` / `rfq_accept` action
// tags but currently lowers them to `UnsupportedAction` on the public
// `/exchange` path (the real handlers run on the EVM core-writer path). The SDK
// emits the byte-correct wire shape each core param struct expects, so these
// go live the moment the node bridges them — no SDK change required.

/// Order side as the **core** RFQ / FBA action handlers deserialize it:
/// PascalCase `"Bid"` / `"Ask"`.
///
/// Deliberately distinct from the snake_case `NativeSide` (`"bid"`/`"ask"`)
/// used by the perp/spot order builders: the node's `core_state::Side` enum
/// carries no `#[serde(rename_all)]`, so the `rfq_request` / `fba_submit`
/// payloads expect PascalCase tokens. Reusing the snake_case side would
/// silently emit `"bid"`/`"ask"` that the core handlers reject.
export type CoreSide = 'Bid' | 'Ask';

/// `rfq_request` — a taker opens an RFQ session asking MMs to quote. Mirrors the
/// node's `core_state` `RfqRequestParams`. The action envelope wraps this under
/// the key **`rfq`** (not `params`).
///
/// `limit_px` and `stp_group` carry NO serde default on the node, so the keys
/// must always be present — an absent value serializes as JSON `null` (the SDK
/// does NOT skip them).
export interface RfqRequest {
  /// Market to request a quote on (`u32`).
  market: number;
  /// Taker side — serializes PascalCase (`"Bid"`/`"Ask"`).
  side: CoreSide;
  /// Requested size (`u128`, `> 0`). `bigint` — emitted as a bare JSON number.
  size: bigint;
  /// Optional worst-acceptable price (`i128`). The key is ALWAYS present:
  /// `null` when absent (do NOT omit). `bigint` — emitted as a bare number.
  limit_px: bigint | null;
  /// Server-clock expiry (ms, `u64`). `0` lets the node default to `ts_ms + 5000`.
  expiry_ms: number;
  /// Optional STP group id (`u64`). The key is ALWAYS present: `null` when
  /// absent (do NOT omit).
  stp_group: number | null;
}

/// `rfq_accept` — a taker crosses against a specific resting quote. Mirrors the
/// node's `RfqAcceptParams`. The action envelope wraps this under the key
/// **`accept`** — note the family inconsistency (`rfq_request` uses `rfq`,
/// `rfq_accept` uses `accept`).
export interface RfqAccept {
  /// Parent RFQ session id (`u64`).
  rfq_id: number;
  /// Index of the accepted quote in the session's quote vector (`u32`).
  quote_idx: number;
  /// Accepted size (`u128`, `<= min(request.size, quote.max_size)`). `bigint` —
  /// emitted as a bare JSON number.
  size: bigint;
}
