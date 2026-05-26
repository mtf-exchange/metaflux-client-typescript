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
//!   `r || s || v` 65-byte wire layout (matches the consensus crate at
//!   `metaflux/crates/consensus/src/signing.rs`).
//! - [`recover_pubkey`] — recover the 33-byte compressed SEC1 pubkey
//!   from a signature + message digest.
//! - [`eip712_typed_data_hash`] — `keccak256(0x1901 || domain || message)`,
//!   the canonical EIP-712 envelope hash. The TS layer assembles the
//!   domain separator and message hash before calling.
//! - [`encode_limit_order`] — canonical msgpack-encoded body for the
//!   MetaFlux `order` action (mirrors
//!   `metaflux/crates/core-state/src/actions/trading.rs::OrderParams`).
//! - [`derive_address_from_pubkey`] — keccak256 of the uncompressed
//!   pubkey, low 20 bytes, the standard EVM address derivation.
//!
//! ## Why WASM vs pure-TS?
//!
//! User direction this session: "包含大量的wasm以提升性能" — push CPU-heavy
//! work (ECDSA scalar math, keccak compression rounds, msgpack encoding)
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
/// Identical to `tiny_keccak::Keccak::v256` used by core-state's
/// `signing::keccak256`. Result format: a freshly-allocated `Vec<u8>`
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
/// `35 + 2*chainId`. The MetaFlux api-gateway and node consume the raw
/// recovery id form — matching the existing consensus crate
/// (`metaflux/crates/consensus/src/signing.rs`). Adjust at the wire
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
/// Mirrors `metaflux/crates/core-state/src/actions/trading.rs::OrderParams`
/// — the exact struct the node deserialises after stripping the
/// `SignedEnvelope` wrapper. Field names must match: serde will produce
/// a msgpack map keyed by the JSON-style names (`asset`, `side`, `px`,
/// `size`, `tif`); the node-side `OrderParams` derives `Deserialize`
/// with the default rmp-serde decoder so the keys ARE load-bearing.
///
/// Numeric encoding:
/// - `asset` is a `u32` per `AssetId(pub u32)` on the node.
/// - `side` is a `u8`: 0 = Bid, 1 = Ask. (See `core-state/src/primitives.rs`
///   for the enum definition the node decodes.)
/// - `px` and `size` are 128-bit fixed-point amounts. Wire layout is
///   little-endian word order: low u64 first, high u64 second, packed
///   into a 16-byte little-endian u128 for canonical encoding.
/// - `tif` is a `u8` mirroring the `Tif` enum.
///
/// Sub-account selection, STP mode, cloid, and reduce-only are deferred
/// in this canonical encoder — the first cut targets `signOrder` for
/// vanilla limit orders. The TS side enforces defaults; richer encoders
/// land alongside the corresponding gateway adapter work.
#[derive(Serialize)]
struct LimitOrderBody {
    asset: u32,
    side: u8,
    px: u128,
    size: u128,
    tif: u8,
}

/// Encode a vanilla limit order to its canonical MTF wire bytes.
///
/// See [`LimitOrderBody`] for the field-by-field semantics and the
/// rationale for the (lo, hi) `u128` split across the wasm-bindgen ABI.
/// Returns the msgpack-encoded body — the TS layer wraps that in the
/// `SignedEnvelope` shape after signing.
#[wasm_bindgen]
pub fn encode_limit_order(
    asset: u32,
    side: u8,
    size_e8_lo: u64,
    size_e8_hi: u64,
    price_e8_lo: u64,
    price_e8_hi: u64,
    tif: u8,
) -> Vec<u8> {
    let size = u128_from_parts(size_e8_lo, size_e8_hi);
    let px = u128_from_parts(price_e8_lo, price_e8_hi);
    let body = LimitOrderBody {
        asset,
        side,
        px,
        size,
        tif,
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
    /// what core-state/signing.rs's `tiny_keccak::Keccak::v256` returns.
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

        let bytes = encode_limit_order(asset, side, size_lo, size_hi, px_lo, px_hi, tif);
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
        }
        let decoded: LimitOrderBodyMirror = rmp_serde::from_slice(&bytes)
            .expect("encoded body must round-trip via rmp_serde::from_slice");
        assert_eq!(decoded.asset, asset);
        assert_eq!(decoded.side, side);
        assert_eq!(decoded.px, px);
        assert_eq!(decoded.size, size);
        assert_eq!(decoded.tif, tif);
    }

    /// encode_limit_order is deterministic — same inputs always
    /// produce identical bytes. Required so client-and-node digests
    /// agree on every replay.
    #[test]
    fn encode_limit_order_is_deterministic() {
        let bytes1 = encode_limit_order(1, 0, 100, 0, 200, 0, 0);
        let bytes2 = encode_limit_order(1, 0, 100, 0, 200, 0, 0);
        assert_eq!(bytes1, bytes2);
    }

    /// Distinct inputs must produce distinct encodings — sanity check
    /// against accidental field-order collapse.
    #[test]
    fn encode_limit_order_differs_per_input() {
        let bytes_bid = encode_limit_order(1, 0, 100, 0, 200, 0, 0);
        let bytes_ask = encode_limit_order(1, 1, 100, 0, 200, 0, 0);
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
