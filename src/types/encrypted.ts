// MTF-native encrypted-order action payload type.
//
// Sender-authorized: the recovered signer is the submitter. Decryption shares
// accumulate over subsequent blocks until `threshold` is met; the order is then
// revealed (checked against `commitment`) and matched.

/// `submit_encrypted_order` — submit a threshold-encrypted order ciphertext.
export interface SubmitEncryptedOrder {
  /// Ciphertext bytes — emitted as a JSON array of byte numbers.
  ciphertext: Uint8Array;
  /// 32-byte `keccak(plaintext‖salt)` commitment binding the revealed order —
  /// emitted as a JSON array of 32 byte numbers.
  commitment: Uint8Array;
  /// Threshold of decryption shares required to reveal (`u8`, `>= 1`).
  threshold: number;
  /// Earliest block at which the ciphertext can be revealed (`u64`).
  target_block: number;
  /// Deadline (unix ms) by which the order must be revealed, else it expires
  /// (`u64`).
  reveal_deadline_ms: number;
}

/// `encrypted_order_submit` — submit a threshold-encrypted order under the
/// node's `evm_integration` `EncryptedOrderSubmitParams`. The action envelope
/// wraps this under the key **`encrypted`**.
///
/// DISTINCT from `SubmitEncryptedOrder`: that 5-field type backs the *different*
/// `submit_encrypted_order` tag (key `params`, the real bridged handler). This
/// 3-field type has **no** `threshold` / `target_block`.
///
/// Forward-compat: the node currently answers this tag with `UnsupportedAction`
/// on the public `/exchange` path; the SDK emits the byte-correct shape the core
/// handler will accept once the bridge lands.
export interface EncryptedOrderSubmit {
  /// Threshold-encrypted order bytes (node decoder bounds this at 4096).
  /// Emitted as a JSON array of byte numbers — pass a `Uint8Array`.
  ciphertext: Uint8Array;
  /// 32-byte `keccak(plaintext‖salt)` commitment. Emitted as a JSON array of
  /// 32 byte numbers — pass a 32-byte `Uint8Array`.
  commitment: Uint8Array;
  /// Absolute consensus-time ms by which a valid plaintext must be revealed
  /// (`u64`).
  reveal_deadline_ms: number;
}
