//! WASM-backed crypto + canonical-encoding primitives for `@metaflux/client`.
//!
//! All hot-path / wire-format work in the TypeScript SDK is funneled
//! through this crate so the JS side never reimplements (and never drifts
//! from) the production wire conventions used by the MetaFlux node.
//!
//! ## Exported surface
//!
//! - [`keccak256`] — 32-byte keccak digest.
//! - [`sign_secp256k1`] — recoverable ECDSA signature in canonical
//!   `r || s || v` 65-byte wire layout (matches the node's signing wire
//!   conventions).
//! - [`recover_pubkey`] — recover the 33-byte compressed SEC1 pubkey
//!   from a signature + message digest.
//! - [`eip712_typed_data_hash`] — `keccak256(0x1901 || domain || message)`,
//!   the canonical EIP-712 envelope hash. The TS layer assembles the
//!   domain separator and message hash before calling.
//! - [`encode_limit_order`] — canonical msgpack-encoded body for the
//!   MetaFlux `order` action (mirrors the node's `OrderParams` action
//!   struct).
//! - [`derive_address_from_pubkey`] — keccak256 of the uncompressed
//!   pubkey, low 20 bytes, the standard EVM address derivation.
//!
//! ## Why WASM vs pure-TS?
//!
//! Pushes CPU-heavy work (ECDSA scalar math, keccak compression rounds,
//! msgpack encoding)
//! out of the V8 interpreter into compiled code. Equally important, it
//! collapses three wire-format reimplementations (TS, Rust client SDK,
//! Rust node) to two: the WASM-side encoder is *literally* the same
//! `rmp_serde::to_vec(&body)` call the node uses on the receiving side.
//!
//! ## 128-bit amounts on the JS boundary
//!
//! `i128`/`u128` cannot cross the wasm-bindgen ABI today. The
//! [`encode_limit_order`] export accepts each 128-bit amount as a pair
//! of `u64`s (`(lo, hi)`, little-endian word order) — the TS layer
//! splits a `bigint` into the pair before the call. Internal arithmetic
//! reconstructs the full `u128` so canonical encoding stays a single
//! source of truth.
//!
//! ## Tests
//!
//! `#[cfg(test)] mod tests` exercises sign/verify, keccak, and EIP-712
//! against the native target — `cargo test -p metaflux_client_wasm`. WASM-
//! target tests are deferred (would need wasm-bindgen-test + a headless
//! browser runner); the primitives are platform-agnostic so native cover
//! is sufficient for the wire-format-parity question.

#![allow(clippy::missing_safety_doc)]

use k256::ecdsa::{
    signature::hazmat::PrehashVerifier as _, RecoveryId, Signature, SigningKey, VerifyingKey,
};
use serde::Serialize;
use sha3::{Digest, Keccak256};
use wasm_bindgen::prelude::*;

// ============================================================================
// Hash primitives
// ============================================================================

/// Compute the 32-byte keccak256 digest of `data`.
///
/// Identical to the keccak256 the node uses for every action digest.
/// Result format: a freshly-allocated `Vec<u8>`
/// of length 32 (the wasm-bindgen ABI marshals to a `Uint8Array`).
#[wasm_bindgen]
pub fn keccak256(data: &[u8]) -> Vec<u8> {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

/// Compute the canonical EIP-712 envelope hash.
///
/// Per EIP-712: `keccak256(0x19 || 0x01 || domain_separator || message_hash)`.
/// `domain_separator` and `message_hash` are each expected to be exactly
/// 32 bytes (the TS layer assembles them via [`keccak256`]); shorter or
/// longer inputs flow through unchanged — the underlying hash absorbs
/// any length, but the receiving node only validates the 32+32-byte
/// canonical shape, so off-spec inputs will fail on recovery rather
/// than panic here.
#[wasm_bindgen]
pub fn eip712_typed_data_hash(domain_separator: &[u8], message_hash: &[u8]) -> Vec<u8> {
    let mut hasher = Keccak256::new();
    hasher.update([0x19, 0x01]);
    hasher.update(domain_separator);
    hasher.update(message_hash);
    hasher.finalize().to_vec()
}

// ============================================================================
// Secp256k1 signing
// ============================================================================

/// Recoverable secp256k1 ECDSA signing — produces the 65-byte
/// `r || s || v` wire form used by every MetaFlux signature surface.
///
/// `priv_key` must be exactly 32 bytes (a valid secp256k1 scalar).
/// `message_hash` is the 32-byte digest the caller has already
/// computed (for EIP-712: feed in [`eip712_typed_data_hash`]'s output).
///
/// Returns: 65-byte `Vec<u8>` laid out as
/// `r (32 bytes BE) || s (32 bytes BE) || v (1 byte: 0 or 1)`.
///
/// Note: `v` is the raw recovery id (`0` or `1`). The EVM convention
/// adds 27 (so `v ∈ {27, 28}`); the EIP-155 convention adds
/// `35 + 2*chainId`. The MetaFlux gateway and node consume the raw
/// recovery id form. Adjust at the wire
/// boundary if you target an EVM-RPC consumer.
///
/// On invalid input (wrong-length key, malformed scalar) returns an
/// empty `Vec` — wasm-bindgen marshals that as a zero-length
/// `Uint8Array` which the TS wrapper translates to a thrown error.
#[wasm_bindgen]
pub fn sign_secp256k1(priv_key: &[u8], message_hash: &[u8]) -> Vec<u8> {
    if priv_key.len() != 32 {
        return Vec::new();
    }
    if message_hash.len() != 32 {
        return Vec::new();
    }
    let key = match SigningKey::from_slice(priv_key) {
        Ok(k) => k,
        Err(_) => return Vec::new(),
    };
    // sign_prehash_recoverable feeds the 32-byte digest straight to ECDSA,
    // bypassing the default SHA-256-of-input pre-hash. Required since our
    // domain hash is keccak256.
    let (sig, recovery_id): (Signature, RecoveryId) = match key.sign_prehash_recoverable(message_hash) {
        Ok(pair) => pair,
        Err(_) => return Vec::new(),
    };
    let sig_bytes = sig.to_bytes();
    let mut out = Vec::with_capacity(65);
    out.extend_from_slice(sig_bytes.as_slice());
    out.push(recovery_id.to_byte());
    out
}

/// Recover the 33-byte compressed SEC1 public key from a recoverable
/// signature + the 32-byte message digest.
///
/// `sig` must be exactly 65 bytes in the `r || s || v` layout produced
/// by [`sign_secp256k1`]. Returns the 33-byte compressed SEC1 pubkey
/// (`(0x02 | 0x03) || x`).
///
/// On malformed input or an unrecoverable signature, returns an empty
/// `Vec`; the TS wrapper translates that to a thrown error.
#[wasm_bindgen]
pub fn recover_pubkey(sig: &[u8], message_hash: &[u8]) -> Vec<u8> {
    if sig.len() != 65 || message_hash.len() != 32 {
        return Vec::new();
    }
    let signature = match Signature::try_from(&sig[..64]) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let recovery_id = match RecoveryId::try_from(sig[64]) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let pubkey = match VerifyingKey::recover_from_prehash(message_hash, &signature, recovery_id) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    pubkey.to_encoded_point(true).as_bytes().to_vec()
}

/// Verify a signature against a known public key + message digest.
///
/// Exposed for symmetry; the TS layer also calls into this when it
/// already knows the expected signer (e.g. validating a counterparty's
/// signed quote). Returns `true` iff the signature is valid.
#[wasm_bindgen]
pub fn verify_secp256k1(pubkey_compressed: &[u8], sig: &[u8], message_hash: &[u8]) -> bool {
    if pubkey_compressed.len() != 33 || sig.len() != 65 || message_hash.len() != 32 {
        return false;
    }
    let pk = match VerifyingKey::from_sec1_bytes(pubkey_compressed) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let signature = match Signature::try_from(&sig[..64]) {
        Ok(s) => s,
        Err(_) => return false,
    };
    pk.verify_prehash(message_hash, &signature).is_ok()
}

// ============================================================================
// EVM address derivation
// ============================================================================

/// Derive the standard 20-byte EVM address from a SEC1 public key.
///
/// Accepts either:
/// - 65-byte uncompressed SEC1 (`0x04 || x || y`) — the 0x04 prefix
///   byte is stripped before hashing.
/// - 64-byte raw `x || y` form — used as-is.
/// - 33-byte compressed (`(0x02|0x03) || x`) — decompressed first.
///
/// Returns the low 20 bytes of `keccak256(uncompressed_xy)`, the
/// canonical EVM convention. On a malformed pubkey, returns an empty
/// `Vec`.
#[wasm_bindgen]
pub fn derive_address_from_pubkey(pubkey: &[u8]) -> Vec<u8> {
    let uncompressed_xy: Vec<u8> = match pubkey.len() {
        65 if pubkey[0] == 0x04 => pubkey[1..].to_vec(),
        64 => pubkey.to_vec(),
        33 => {
            // Decompress via k256 — needed because EVM address derivation
            // is over the uncompressed x||y form, not the compressed form.
            let vk = match VerifyingKey::from_sec1_bytes(pubkey) {
                Ok(v) => v,
                Err(_) => return Vec::new(),
            };
            let encoded = vk.to_encoded_point(false);
            let bytes = encoded.as_bytes();
            if bytes.len() != 65 || bytes[0] != 0x04 {
                return Vec::new();
            }
            bytes[1..].to_vec()
        }
        _ => return Vec::new(),
    };
    let mut hasher = Keccak256::new();
    hasher.update(&uncompressed_xy);
    let digest = hasher.finalize();
    digest[12..].to_vec()
}

// ============================================================================
// Canonical action encoding — LimitOrder
// ============================================================================

/// Canonical msgpack body for the `order` action.
///
/// Mirrors the node's `OrderParams`
/// — the exact struct the node deserialises after stripping the
/// `SignedEnvelope` wrapper. Field names must match: serde will produce
/// a msgpack map keyed by the JSON-style names (`asset`, `side`, `px`,
/// `size`, `tif`); the node-side `OrderParams` derives `Deserialize`
/// with the default rmp-serde decoder so the keys ARE load-bearing.
///
/// Numeric encoding:
/// - `asset` is a `u32` per `AssetId(pub u32)` on the node.
/// - `side` is a `u8`: 0 = Bid, 1 = Ask (the node's enum variant order).
/// - `px` and `size` are 128-bit fixed-point amounts. Wire layout is
///   little-endian word order: low u64 first, high u64 second, packed
///   into a 16-byte little-endian u128 for canonical encoding.
/// - `tif` is a `u8` mirroring the `Tif` enum.
/// - `stp` is a `u8` mirroring the `StpMode` enum (0 = CancelNewest [default],
///   1 = CancelOldest, 2 = CancelBoth, 3 = DecrementAndCancel). REQUIRED on the
///   wire — `OrderParams.stp` is a non-`Option`, non-`#[serde(default)]` field,
///   so a missing key fails `from_slice` ("missing field `stp`").
/// - `reduce_only` is a `bool` mirroring `OrderParams.reduce_only`. REQUIRED on
///   the wire for the same reason (plain `bool`, no default).
///
/// ## Why `u8` for the externally-tagged enums (`side`/`tif`/`stp`)
///
/// The node's `Side`/`Tif`/`StpMode` derive a plain externally-tagged
/// `Deserialize`. `rmp_serde::to_vec_named` SERIALISES those as the
/// variant-name STRING (`"Ask"`, `"Gtc"`, `"CancelNewest"`), but the decoder
/// ALSO accepts an integer = the variant index. We emit the compact `u8`
/// index form (verified to round-trip into the node enums). This is
/// intentional and load-bearing: the index ordering MUST match the node's
/// enum declaration order.
///
/// ## Optional fields
///
/// - `cloid` mirrors `OrderParams.cloid: Option<Cloid>`. `Cloid` is a
///   `#[serde(transparent)]` newtype over `u128`, which `rmp_serde` encodes as
///   a 16-byte big-endian binary blob — so on the SIGNED wire `cloid` is the
///   raw `u128`, NOT the hex string the higher-level Rust SDK uses at its API
///   boundary. `OrderParams.cloid` has NO `#[serde(default)]`, but `rmp_serde`
///   fills a missing `Option` field with `None` regardless, so we
///   `skip_serializing_if = "Option::is_none"` — a cloid-less order omits the
///   key and still decodes as `cloid: None` (probe-verified:
///   `MISSING_CLOID_KEY => Ok(None)`).
/// - `builder` mirrors `OrderParams.builder: Option<Builder>`
///   (`#[serde(default)]`, ADR-012 §L.5.2). `None` skips the field entirely so
///   a builder-less order encodes byte-identically to before this addition.
///   When present it rides INSIDE the signed body so the builder carve cannot
///   be tampered post-signature.
///
/// Field order here mirrors `OrderParams`; `to_vec_named` emits a named map so
/// the field NAMES (not order) are what the node decoder keys on.
#[derive(Serialize)]
struct LimitOrderBody {
    asset: u32,
    side: u8,
    px: u128,
    size: u128,
    tif: u8,
    stp: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloid: Option<u128>,
    reduce_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    builder: Option<BuilderBody>,
}

/// Canonical msgpack mirror of `trading::Builder { fee: u16, user: Address }`.
///
/// `user` is the raw 20-byte address — `Address` is `#[serde(transparent)]`
/// over `[u8; 20]` on the node, so the wire form is just the bytes. Field
/// names (`fee`, `user`) are load-bearing: serde produces a named-field
/// msgpack map the node's `rmp_serde::from_slice::<Builder>` keys on.
#[derive(Serialize)]
struct BuilderBody {
    fee: u16,
    user: [u8; 20],
}

/// Encode a vanilla limit order to its canonical MTF wire bytes.
///
/// See [`LimitOrderBody`] for the field-by-field semantics and the
/// rationale for the (lo, hi) `u128` split across the wasm-bindgen ABI.
/// Returns the msgpack-encoded body — the TS layer wraps that in the
/// `SignedEnvelope` shape after signing.
///
/// `stp` is the `StpMode` variant index (0 = CancelNewest default). `reduce_only`
/// is the reduce-only flag. Both are REQUIRED node-side and always encoded.
///
/// Cloid (`OrderParams.cloid: Option<Cloid>`): pass `has_cloid = false` for no
/// client order id (the `cloid` key is omitted — the node fills `None`). When
/// `has_cloid = true`, `cloid_lo`/`cloid_hi` are the little-endian word halves
/// of the 128-bit cloid; it rides the signed body as the raw `u128` (the wire
/// form the node's `Cloid(u128)` decodes), NOT a hex string.
///
/// Builder carve (ADR-012 §L.5.2): pass `has_builder = false` for a
/// vanilla order (encodes identically to a no-builder body — the
/// `builder` key is omitted). When `has_builder = true`, `builder_fee`
/// is the rate in basis points and `builder_user` MUST be exactly 20
/// bytes (the raw EVM address). A wrong-length `builder_user` returns an
/// empty `Vec` (the TS wrapper raises a clean error) rather than
/// silently dropping the field — a dropped builder would be an unsigned
/// carve, worse than a hard failure.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn encode_limit_order(
    asset: u32,
    side: u8,
    size_e8_lo: u64,
    size_e8_hi: u64,
    price_e8_lo: u64,
    price_e8_hi: u64,
    tif: u8,
    stp: u8,
    has_cloid: bool,
    cloid_lo: u64,
    cloid_hi: u64,
    reduce_only: bool,
    has_builder: bool,
    builder_fee: u16,
    builder_user: &[u8],
) -> Vec<u8> {
    let size = u128_from_parts(size_e8_lo, size_e8_hi);
    let px = u128_from_parts(price_e8_lo, price_e8_hi);
    let cloid = if has_cloid {
        Some(u128_from_parts(cloid_lo, cloid_hi))
    } else {
        None
    };
    let builder = if has_builder {
        let user: [u8; 20] = match builder_user.try_into() {
            Ok(arr) => arr,
            Err(_) => return Vec::new(),
        };
        Some(BuilderBody {
            fee: builder_fee,
            user,
        })
    } else {
        None
    };
    let body = LimitOrderBody {
        asset,
        side,
        px,
        size,
        tif,
        stp,
        cloid,
        reduce_only,
        builder,
    };
    // rmp_serde::to_vec produces the canonical msgpack map (named-field
    // form), matching what `rmp_serde::from_slice::<OrderParams>` on the
    // node-side decoder expects. Failure here is unreachable for a
    // small fixed-size struct, but we return Vec::new() rather than
    // panicking so the TS wrapper raises a clean error.
    match rmp_serde::to_vec_named(&body) {
        Ok(bytes) => bytes,
        Err(_) => Vec::new(),
    }
}

/// Recombine the (lo, hi) pair the TS layer splits `bigint` into.
///
/// The wasm-bindgen ABI rejects `u128` directly; we transmit it as a
/// pair of `u64` words in little-endian order (low word first, high
/// word second) and reconstruct here. Equivalent to
/// `BigInt(hi) << 64n | BigInt(lo)` on the TS side.
fn u128_from_parts(lo: u64, hi: u64) -> u128 {
    (u128::from(hi) << 64) | u128::from(lo)
}

// ============================================================================
// Tests (native target — quick `cargo test` cycle)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// keccak256("") — the canonical empty-input digest from the
    /// Ethereum yellow paper. Locks in that `sha3::Keccak256` matches
    /// the keccak256 the node computes.
    #[test]
    fn keccak256_empty_known_vector() {
        let expected: [u8; 32] = [
            0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c, 0x92, 0x7e, 0x7d, 0xb2, 0xdc, 0xc7,
            0x03, 0xc0, 0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b, 0x7b, 0xfa, 0xd8, 0x04,
            0x5d, 0x85, 0xa4, 0x70,
        ];
        assert_eq!(keccak256(b"")[..], expected);
    }

    /// keccak256("abc") — second known vector. Catches keccak-vs-SHA3
    /// confusion (SHA3-256 of "abc" differs from keccak256 of "abc";
    /// using the wrong primitive would corrupt every signature).
    #[test]
    fn keccak256_abc_known_vector() {
        let expected =
            hex::decode("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
                .unwrap();
        assert_eq!(keccak256(b"abc"), expected);
    }

    /// sign → recover round-trip. The pubkey recovered from a signature
    /// must equal the signing key's actual pubkey.
    #[test]
    fn sign_then_recover_yields_signing_pubkey() {
        // 32-byte private key (any non-zero scalar works).
        let priv_key = [0x42u8; 32];
        let msg_hash = keccak256(b"vote{round=10,block=...}");
        let sig = sign_secp256k1(&priv_key, &msg_hash);
        assert_eq!(sig.len(), 65, "wire form is r||s||v = 65 bytes");

        let recovered = recover_pubkey(&sig, &msg_hash);
        assert_eq!(recovered.len(), 33, "compressed SEC1 form is 33 bytes");

        // Cross-check: build the SigningKey directly and compare its
        // compressed pubkey to what recover_pubkey produced.
        let key = SigningKey::from_slice(&priv_key).unwrap();
        let expected = key.verifying_key().to_encoded_point(true).as_bytes().to_vec();
        assert_eq!(recovered, expected);
    }

    /// sign → verify round-trip. The signature must validate under the
    /// signing key's pubkey.
    #[test]
    fn sign_then_verify_passes() {
        let priv_key = [0x11u8; 32];
        let key = SigningKey::from_slice(&priv_key).unwrap();
        let pubkey_compressed = key.verifying_key().to_encoded_point(true).as_bytes().to_vec();
        let msg_hash = keccak256(b"hello world");

        let sig = sign_secp256k1(&priv_key, &msg_hash);
        assert!(verify_secp256k1(&pubkey_compressed, &sig, &msg_hash));
    }

    /// sign is deterministic — RFC 6979 nonces guarantee
    /// (key, message) → identical bytes on every run.
    #[test]
    fn sign_is_deterministic() {
        let priv_key = [0x07u8; 32];
        let msg_hash = keccak256(b"deterministic");
        let s1 = sign_secp256k1(&priv_key, &msg_hash);
        let s2 = sign_secp256k1(&priv_key, &msg_hash);
        assert_eq!(s1, s2);
    }

    /// verify rejects a mutated signature (single byte flipped in r).
    #[test]
    fn verify_rejects_mutated_signature() {
        let priv_key = [0x33u8; 32];
        let key = SigningKey::from_slice(&priv_key).unwrap();
        let pubkey_compressed = key.verifying_key().to_encoded_point(true).as_bytes().to_vec();
        let msg_hash = keccak256(b"tamper");
        let mut sig = sign_secp256k1(&priv_key, &msg_hash);
        sig[0] ^= 0xff;
        assert!(!verify_secp256k1(&pubkey_compressed, &sig, &msg_hash));
    }

    /// sign_secp256k1 rejects a wrong-length private key by returning empty.
    #[test]
    fn sign_with_bad_key_length_returns_empty() {
        let bad_priv = [0u8; 31]; // 31 != 32
        let msg_hash = [0u8; 32];
        let sig = sign_secp256k1(&bad_priv, &msg_hash);
        assert!(sig.is_empty());
    }

    /// EIP-712 typed data hash matches a hand-built reference.
    /// Locks in the `0x1901 || domain || message` composition.
    #[test]
    fn eip712_typed_data_hash_matches_hand_built() {
        let domain_sep = [0xaa_u8; 32];
        let msg_hash = [0xbb_u8; 32];

        // Hand-rebuild via the underlying hasher.
        let mut h = Keccak256::new();
        h.update([0x19, 0x01]);
        h.update(domain_sep);
        h.update(msg_hash);
        let expected = h.finalize().to_vec();

        let actual = eip712_typed_data_hash(&domain_sep, &msg_hash);
        assert_eq!(actual, expected);
    }

    /// EIP-712 hash changes when the domain separator changes — guards
    /// against the "all domains hash the same" bug.
    #[test]
    fn eip712_typed_data_hash_domain_sensitive() {
        let msg_hash = [0x01u8; 32];
        let dom_a = [0x10u8; 32];
        let dom_b = [0x11u8; 32];
        let ha = eip712_typed_data_hash(&dom_a, &msg_hash);
        let hb = eip712_typed_data_hash(&dom_b, &msg_hash);
        assert_ne!(ha, hb);
    }

    /// Address derivation against a known SEC1 pubkey. Cross-references
    /// the EVM convention: low 20 bytes of keccak256(uncompressed_xy).
    #[test]
    fn derive_address_from_pubkey_matches_evm_convention() {
        let priv_key = [0x99u8; 32];
        let key = SigningKey::from_slice(&priv_key).unwrap();
        let compressed = key.verifying_key().to_encoded_point(true).as_bytes().to_vec();
        let uncompressed = key.verifying_key().to_encoded_point(false).as_bytes().to_vec();
        assert_eq!(compressed.len(), 33);
        assert_eq!(uncompressed.len(), 65);
        assert_eq!(uncompressed[0], 0x04);

        // Hand-derive expected address: keccak256(x||y)[12..32].
        let xy = &uncompressed[1..];
        let mut h = Keccak256::new();
        h.update(xy);
        let digest = h.finalize();
        let expected: Vec<u8> = digest[12..].to_vec();

        // Both compressed + uncompressed forms must produce the same
        // address — the function decompresses internally for the
        // 33-byte case.
        let from_compressed = derive_address_from_pubkey(&compressed);
        let from_uncompressed = derive_address_from_pubkey(&uncompressed);
        assert_eq!(from_compressed, expected);
        assert_eq!(from_uncompressed, expected);
        assert_eq!(from_compressed.len(), 20);
    }

    /// Address derivation rejects malformed pubkey lengths.
    #[test]
    fn derive_address_from_pubkey_rejects_bad_length() {
        assert!(derive_address_from_pubkey(&[]).is_empty());
        assert!(derive_address_from_pubkey(&[0u8; 17]).is_empty());
    }

    /// encode_limit_order produces a non-empty msgpack body that
    /// round-trips through `rmp_serde::from_slice` back to identical
    /// field values. We don't lock in the exact bytes (msgpack
    /// encoders pick fixmap vs map32 by size), but the named-field
    /// shape MUST match what the node decoder expects.
    #[test]
    fn encode_limit_order_roundtrips() {
        // ETH-USDC perp, BUY, 1.5 ETH @ 3000 USDC, GTC.
        // Using e8 scaling: 1.5 * 1e8 = 150_000_000; 3000 * 1e8 = 300_000_000_000.
        let asset: u32 = 5;
        let side: u8 = 0; // Bid
        let size: u128 = 150_000_000;
        let px: u128 = 300_000_000_000;
        let tif: u8 = 0;

        let size_lo = size as u64;
        let size_hi = (size >> 64) as u64;
        let px_lo = px as u64;
        let px_hi = (px >> 64) as u64;

        let bytes = encode_limit_order(
            asset, side, size_lo, size_hi, px_lo, px_hi, tif, 0, false, 0, 0, false, false, 0, &[],
        );
        assert!(!bytes.is_empty(), "encoder should not fail on valid inputs");

        // Round-trip via rmp_serde into a typed mirror of LimitOrderBody.
        // rmp_serde encodes `u128` as a 16-byte big-endian payload tagged
        // ext-style; using a typed Deserialize target unpacks it cleanly.
        // We avoid `serde_json::Value` because msgpack carries types JSON
        // does not (binary, ext, u128) — a generic JSON-style decode
        // loses fidelity here, which is itself a useful signal that the
        // node-side decoder must use rmp_serde, not a JSON adapter.
        #[derive(serde::Deserialize, Debug, PartialEq, Eq)]
        struct LimitOrderBodyMirror {
            asset: u32,
            side: u8,
            px: u128,
            size: u128,
            tif: u8,
            stp: u8,
            #[serde(default)]
            cloid: Option<u128>,
            reduce_only: bool,
        }
        let decoded: LimitOrderBodyMirror = rmp_serde::from_slice(&bytes)
            .expect("encoded body must round-trip via rmp_serde::from_slice");
        assert_eq!(decoded.asset, asset);
        assert_eq!(decoded.side, side);
        assert_eq!(decoded.px, px);
        assert_eq!(decoded.size, size);
        assert_eq!(decoded.tif, tif);
        assert_eq!(decoded.stp, 0);
        assert_eq!(decoded.cloid, None);
        assert!(!decoded.reduce_only);
    }

    /// The encoded body must carry EXACTLY the node `OrderParams` key set
    /// (`asset/side/px/size/tif/stp/reduce_only` always; `cloid`/`builder`
    /// when present). Decoding into a node-shaped mirror that makes `stp` +
    /// `reduce_only` REQUIRED (no `#[serde(default)]`) proves both keys are on
    /// the wire — the node's `OrderParams` would otherwise reject the payload
    /// ("missing field `stp`" / "missing field `reduce_only`").
    #[test]
    fn encode_limit_order_carries_required_stp_and_reduce_only() {
        #[derive(serde::Deserialize, Debug, PartialEq, Eq)]
        struct OrderParamsMirror {
            asset: u32,
            side: u8,
            px: u128,
            size: u128,
            tif: u8,
            stp: u8,
            #[serde(default)]
            cloid: Option<u128>,
            reduce_only: bool,
        }
        // stp = 2 (CancelBoth), reduce_only = true, no cloid.
        let bytes =
            encode_limit_order(3, 1, 7, 0, 11, 0, 1, 2, false, 0, 0, true, false, 0, &[]);
        let decoded: OrderParamsMirror = rmp_serde::from_slice(&bytes)
            .expect("must decode into a mirror with REQUIRED stp + reduce_only");
        assert_eq!(decoded.stp, 2);
        assert!(decoded.reduce_only);
        assert_eq!(decoded.cloid, None);
    }

    /// `cloid` rides the signed body as the raw `u128` (the node's
    /// `Cloid(u128)` wire form), reconstructed from the (lo, hi) ABI pair.
    #[test]
    fn encode_limit_order_with_cloid_roundtrips() {
        #[derive(serde::Deserialize, Debug, PartialEq, Eq)]
        struct OrderParamsMirror {
            asset: u32,
            side: u8,
            px: u128,
            size: u128,
            tif: u8,
            stp: u8,
            cloid: Option<u128>,
            reduce_only: bool,
        }
        let cloid: u128 = (1u128 << 64) | 0xDEAD_BEEFu128;
        let lo = cloid as u64;
        let hi = (cloid >> 64) as u64;
        let bytes =
            encode_limit_order(3, 0, 7, 0, 11, 0, 2, 0, true, lo, hi, false, false, 0, &[]);
        let decoded: OrderParamsMirror = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.cloid, Some(cloid));
        assert_eq!(decoded.stp, 0);
    }

    /// `has_cloid = false` omits the `cloid` key; a node-shaped mirror with
    /// `Option<u128>` (no `#[serde(default)]`) still decodes it as `None`
    /// because rmp_serde fills a missing Option field with None.
    #[test]
    fn encode_limit_order_without_cloid_omits_key() {
        let with_cloid =
            encode_limit_order(3, 0, 7, 0, 11, 0, 2, 0, true, 1, 0, false, false, 0, &[]);
        let no_cloid =
            encode_limit_order(3, 0, 7, 0, 11, 0, 2, 0, false, 0, 0, false, false, 0, &[]);
        assert!(with_cloid.len() > no_cloid.len(), "cloid key must be omitted");
    }

    /// A builder carve must ride INSIDE the encoded body and round-trip
    /// into the node-shaped `OrderParams` mirror (with `Option<Builder>`).
    /// Field names + the (fee: u16, user: [u8;20]) shape are load-bearing.
    #[test]
    fn encode_limit_order_with_builder_roundtrips() {
        #[derive(serde::Deserialize, Debug, PartialEq, Eq)]
        struct BuilderMirror {
            fee: u16,
            user: [u8; 20],
        }
        #[derive(serde::Deserialize, Debug, PartialEq, Eq)]
        struct OrderMirror {
            asset: u32,
            side: u8,
            px: u128,
            size: u128,
            tif: u8,
            #[serde(default)]
            builder: Option<BuilderMirror>,
        }

        let user = [0xABu8; 20];
        let bytes = encode_limit_order(7, 1, 50, 0, 99, 0, 0, 0, false, 0, 0, false, true, 5, &user);
        assert!(!bytes.is_empty());
        let decoded: OrderMirror = rmp_serde::from_slice(&bytes)
            .expect("builder body must round-trip");
        assert_eq!(decoded.asset, 7);
        assert_eq!(decoded.side, 1);
        assert_eq!(
            decoded.builder,
            Some(BuilderMirror { fee: 5, user })
        );
    }

    /// `has_builder = false` must omit the `builder` key entirely — the
    /// encoding is byte-identical to the pre-builder encoder so existing
    /// signatures and replay digests do not shift.
    #[test]
    fn encode_limit_order_without_builder_omits_key() {
        // Mirror that REQUIRES builder to be absent (no #[serde(default)]):
        // if the key were emitted, this decode would still pass, so we also
        // assert the byte length is shorter than the with-builder form.
        let no_builder =
            encode_limit_order(7, 1, 50, 0, 99, 0, 0, 0, false, 0, 0, false, false, 0, &[]);
        let with_builder =
            encode_limit_order(7, 1, 50, 0, 99, 0, 0, 0, false, 0, 0, false, true, 5, &[0xABu8; 20]);
        assert!(!no_builder.is_empty());
        assert!(with_builder.len() > no_builder.len());

        // The no-builder body must still decode into the node shape with
        // builder defaulting to None.
        #[derive(serde::Deserialize, Debug, PartialEq, Eq)]
        struct OrderMirror {
            asset: u32,
            side: u8,
            px: u128,
            size: u128,
            tif: u8,
            #[serde(default)]
            builder: Option<()>,
        }
        let decoded: OrderMirror = rmp_serde::from_slice(&no_builder).unwrap();
        assert_eq!(decoded.builder, None);
    }

    /// A wrong-length builder address must hard-fail (empty Vec), never
    /// silently drop the carve — a dropped builder would be unsigned.
    #[test]
    fn encode_limit_order_rejects_bad_builder_user_len() {
        let bad =
            encode_limit_order(7, 1, 50, 0, 99, 0, 0, 0, false, 0, 0, false, true, 5, &[0u8; 19]);
        assert!(bad.is_empty());
    }

    /// encode_limit_order is deterministic — same inputs always
    /// produce identical bytes. Required so client-and-node digests
    /// agree on every replay.
    #[test]
    fn encode_limit_order_is_deterministic() {
        let bytes1 =
            encode_limit_order(1, 0, 100, 0, 200, 0, 0, 0, false, 0, 0, false, false, 0, &[]);
        let bytes2 =
            encode_limit_order(1, 0, 100, 0, 200, 0, 0, 0, false, 0, 0, false, false, 0, &[]);
        assert_eq!(bytes1, bytes2);
    }

    /// Distinct inputs must produce distinct encodings — sanity check
    /// against accidental field-order collapse.
    #[test]
    fn encode_limit_order_differs_per_input() {
        let bytes_bid =
            encode_limit_order(1, 0, 100, 0, 200, 0, 0, 0, false, 0, 0, false, false, 0, &[]);
        let bytes_ask =
            encode_limit_order(1, 1, 100, 0, 200, 0, 0, 0, false, 0, 0, false, false, 0, &[]);
        assert_ne!(bytes_bid, bytes_ask);
    }

    /// 128-bit recombination utility behaves correctly across the
    /// 64-bit boundary.
    #[test]
    fn u128_from_parts_handles_high_word() {
        let lo = 0xFFFF_FFFF_FFFF_FFFFu64;
        let hi = 0x0000_0000_0000_0001u64;
        let combined = u128_from_parts(lo, hi);
        let expected: u128 = (1u128 << 64) | u128::from(lo);
        assert_eq!(combined, expected);
    }
}
