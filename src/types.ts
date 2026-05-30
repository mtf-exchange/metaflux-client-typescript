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

/// Self-trade-prevention mode as the MTF wire variant index — matches the
/// declaration order of `core_state::primitives::StpMode`. The node decodes
/// the integer into the enum variant; the index ordering is load-bearing.
/// 0 = CancelNewest (default), 1 = CancelOldest, 2 = CancelBoth,
/// 3 = DecrementAndCancel.
export type StpMode = 0 | 1 | 2 | 3;

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
  /// Self-trade-prevention mode (matches `OrderParams.stp: StpMode`). The node
  /// requires this field on the signed wire (no serde default). Omit to default
  /// to `0` (CancelNewest) — the encoder fills it in.
  stp?: StpMode;
  /// Optional client order id (matches `OrderParams.cloid: Option<Cloid>`,
  /// `Cloid(u128)`). On the SIGNED wire this is the raw 128-bit integer, so it
  /// is a `bigint` here (NOT a hex string). Omit for no cloid — the encoder
  /// skips the key and the node fills `None`.
  cloid?: bigint;
  /// Reduce-only flag (matches `OrderParams.reduce_only: bool`). The node
  /// requires this field on the signed wire (no serde default). Omit to default
  /// to `false` — the encoder fills it in.
  reduceOnly?: boolean;
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

/// MTF-native order action shape (snake_case), byte-for-byte mirror of the
/// server `NativeOrder` (`metaflux/crates/api-node/src/rest/native_action.rs`).
/// These string/number forms are EXACTLY what rides inside the signed
/// `action` JSON posted to `POST /exchange` — the digest covers the
/// full object, so every field here is part of the signed bytes.
///
/// Field ORDER is load-bearing: the server verifies the signature over the
/// raw `action` bytes, so the client must emit keys in this exact order and
/// the same bytes it signed (see `buildNativeOrderAction`).
export interface NativeOrder {
  /// `0x`-hex 20-byte owner. MUST equal the signing wallet's address; the
  /// server authenticates via the recovered signer and requires it to equal
  /// `owner` (or an approved agent of it).
  owner: string;
  /// Target market id (`u32`).
  market: number;
  /// Side: `"bid"` (buy) or `"ask"` (sell).
  side: NativeSide;
  /// Order kind. Only `"limit"` / `"market"` map server-side today.
  kind: NativeOrderKind;
  /// Size in fixed-point tick units (`u64` on the wire).
  size: number;
  /// Limit price in fixed-point tick units (`u64` on the wire).
  limit_px: number;
  /// Time-in-force.
  tif: NativeTif;
  /// Self-trade-prevention mode.
  stp_mode: NativeStpMode;
  /// Reduce-only flag.
  reduce_only: boolean;
  /// Optional `0x`-hex 32-char (16-byte) client order id. Omitted from the
  /// signed bytes entirely when absent.
  cloid?: string;
  /// Optional builder-code carve. Rides INSIDE the signed action object.
  builder?: NativeBuilder;
}

/// MTF-native side string — mirrors the server `NativeSide`.
export type NativeSide = 'bid' | 'ask';

/// MTF-native order kind — mirrors the server `NativeOrderKind`. Only
/// `limit` / `market` are mapped server-side; `stop_loss` / `take_profit`
/// are rejected (triggers not wired).
export type NativeOrderKind = 'limit' | 'market' | 'stop_loss' | 'take_profit';

/// MTF-native time-in-force — mirrors the server `NativeTif`. `aon` is
/// rejected server-side (no core equivalent).
export type NativeTif = 'gtc' | 'ioc' | 'aon' | 'alo';

/// MTF-native self-trade-prevention — mirrors the server `NativeStpMode`.
/// `reject` is rejected server-side (no core equivalent).
export type NativeStpMode =
  | 'cancel_oldest'
  | 'cancel_newest'
  | 'cancel_both'
  | 'reject';

/// MTF-native builder carve — mirrors the server `NativeBuilder`. Rides
/// inside the signed action bytes.
export interface NativeBuilder {
  /// Builder fee in basis points (`u16`).
  fee: number;
  /// `0x`-hex 20-byte address credited with the builder fee.
  user: string;
}

/// Signed native action envelope posted to `POST /exchange`.
///
/// `action` is the raw JSON STRING (not a parsed object) so the bytes sent
/// are byte-identical to the bytes signed — the server recovers the signer
/// over the exact `action` bytes (`serde_json::value::RawValue`). `signature`
/// is the `0x`-prefixed 65-byte `r||s||v` secp256k1 signature.
export interface NativeSignedAction {
  /// Raw JSON bytes of the action object — what was signed AND what is sent.
  actionJson: string;
  /// Per-owner replay nonce bound into the signed digest.
  nonce: bigint;
  /// `0x`-prefixed 65-byte recoverable secp256k1 signature.
  signature: string;
}

/// Server response to `POST /exchange`. Mirrors the node
/// `ExchangeResponse` (`metaflux/crates/api-node/src/rest/exchange.rs`).
export interface NativeExchangeAck {
  /// Whether the action was admitted to the mempool.
  accepted: boolean;
  /// Rejection reason, when `accepted` is false.
  error?: string;
  /// Mempool depth observed at admission time (diagnostic).
  mempool_depth: number;
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
