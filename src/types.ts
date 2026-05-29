// Type definitions for the @metaflux/client surface.
//
// Shapes mirror the CCXT-compat REST responses emitted by the MetaFlux
// api-gateway (`metaflux/crates/api-gateway/src/ccxt/types.rs`). The
// monetary-fields-as-decimal-strings convention is load-bearing — CCXT
// clients pass these straight into `Decimal(value)` and any drift to
// number-typed fields silently loses precision.
//
// `Order` / `SignedOrder` are MTF-native (they carry pre-signed bytes
// the gateway forwards to the node). The other types match what the
// gateway emits.

/// Side as MTF wire bytes — matches `core_state::primitives::Side`.
/// 0 = Bid (buy), 1 = Ask (sell). The CCXT REST surface uses the
/// strings `"buy"` / `"sell"` instead; the Client class translates
/// between the two at the boundary.
export type Side = 0 | 1;

/// Time-in-force on the MTF wire — matches `core_state::primitives::Tif`.
/// 0 = GTC (Good-Til-Cancelled), 1 = IOC, 2 = ALO (Add-Liquidity-Only / post-only).
/// Other values are reserved.
export type Tif = 0 | 1 | 2;

/// Builder-code carve attached to an order (ADR-012 §L.5.2; mirrors
/// `core_state::actions::trading::Builder`). When present it is encoded
/// INSIDE the signed order body (see `encodeLimitOrder` / the WASM
/// `encode_limit_order`), so the carve cannot be tampered post-signature.
export interface Builder {
  /// Builder fee rate in basis points (≤ 8, and ≤ the trader's approved
  /// per-builder ceiling — the node rejects over-cap / unapproved
  /// builders pre-trade). Charged as an ADDITIONAL fee on the taker.
  fee: number;
  /// Builder address credited per fill — `0x`-prefixed 40-char hex
  /// (20 bytes). The node rejects the zero address.
  user: string;
}

/// Pre-signing order parameters. The TS-side amounts use `bigint` rather
/// than `number` because every monetary value on the MetaFlux wire is a
/// 128-bit fixed-point integer scaled by 1e8. `number` would silently
/// truncate values above 2^53; `bigint` matches the wire faithfully.
export interface Order {
  /// On-chain asset ID (matches `core_state::primitives::AssetId(pub u32)`).
  asset: number;
  /// 0 = buy, 1 = sell.
  side: Side;
  /// Limit price, fixed-point scaled by 1e8 (matches FixedPrice on the node).
  /// Example: 3000.50 USDC -> 300_050_000_000n.
  priceE8: bigint;
  /// Order size in base currency, fixed-point scaled by 1e8 (FixedSize).
  /// Example: 0.5 BTC -> 50_000_000n.
  sizeE8: bigint;
  /// Time-in-force on the MTF wire.
  tif: Tif;
  /// Optional builder-code carve (ADR-012 §L.5.2). Omit for a vanilla
  /// order; when set it rides inside the EIP-712-signed body.
  builder?: Builder;
}

/// Order body + signature bundle the client posts to the gateway.
///
/// `payload` is the rmp_serde-encoded body produced by
/// `encode_limit_order` in the WASM crate. `signature` is the 65-byte
/// `r || s || v` recoverable ECDSA sig over the EIP-712 typed-data
/// hash of `payload`. `signer` is the 20-byte EVM address derived from
/// the signing key — included so the gateway can reject envelopes
/// whose recovered key doesn't match the claimed sender without first
/// doing the ECDSA recovery (cheap rejection of obvious replays).
export interface SignedOrder {
  /// MTF-canonical wire bytes of the unsigned order body.
  payload: Uint8Array;
  /// 65-byte recoverable secp256k1 signature: `r || s || v`.
  signature: Uint8Array;
  /// 20-byte EVM address the signature claims to be from.
  signer: Uint8Array;
}

/// Acknowledgement from `submitOrder`. Mirrors `Order` from the CCXT REST
/// response shape (`api-gateway/src/ccxt/types.rs::Order`); monetary
/// fields are decimal strings to match what the gateway emits.
export interface OrderAck {
  id: string;
  timestamp: number;
  datetime: string;
  symbol: string;
  type: 'limit' | 'market';
  side: 'buy' | 'sell';
  price?: string;
  amount: string;
  filled: string;
  remaining: string;
  status: 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';
  clientOrderId?: string;
}

/// CCXT market descriptor — one entry of `fetchMarkets`. See the
/// gateway's `Market` struct for the exhaustive shape; we model the
/// fields every CCXT client iterates and leave room for extension.
export interface Market {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  settle?: string;
  active: boolean;
  spot: boolean;
  contract: boolean;
  swap: boolean;
  future: boolean;
  linear: boolean;
  precision: { amount: number; price: number };
  limits: {
    amount: { min?: string; max?: string };
    price: { min?: string; max?: string };
    cost: { min?: string; max?: string };
  };
}

/// CCXT position snapshot. Sign of the position is in `side`, never in
/// `contracts` (always non-negative).
export interface Position {
  symbol: string;
  side: 'long' | 'short';
  contracts: string;
  notional?: string;
  entryPrice?: string;
  markPrice?: string;
  liquidationPrice?: string;
  unrealizedPnl?: string;
  leverage?: string;
  timestamp: number;
}

/// Error envelope every CCXT 4xx/5xx response carries. The Client
/// throws `MetaFluxApiError` (defined in http.ts) when the gateway
/// returns this shape.
export interface ErrorEnvelope {
  error: string;
}
