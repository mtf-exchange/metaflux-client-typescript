// MTF-native encrypted-order action payload types.
//
// Sender-authorized: the recovered signer is the submitter. Decryption shares
// accumulate over subsequent blocks until `threshold` is met; the order is then
// revealed (checked against `commitment`) and matched.

/// `submit_encrypted_order` — submit a threshold-encrypted order ciphertext.
/// Mirrors the node's frozen `SubmitEncryptedOrder` typed struct.
export interface SubmitEncryptedOrder {
  /// Ciphertext bytes — emitted as a JSON array of byte numbers.
  ciphertext: Uint8Array;
  /// 32-byte `keccak(plaintext‖salt)` commitment binding the revealed order —
  /// emitted as a JSON array of 32 byte numbers.
  commitment: Uint8Array;
  /// Threshold of decryption shares required to reveal (`u8`, `>= 1`).
  threshold: number;
  /// Earliest block at which the ciphertext can be revealed (`u64`).
  target_block: number | bigint;
  /// Deadline (unix ms) by which the order must be revealed, else it expires
  /// (`u64`).
  reveal_deadline_ms: number | bigint;
}

/// `encrypted_order_submit` — a NEW `/exchange` action tag that ALIASES the
/// `SubmitEncryptedOrder` typed digest (same EIP-712 struct, only the wire
/// `type` tag differs). It carries the SAME 5-field W1 payload as
/// `SubmitEncryptedOrder` (was a distinct 3-field opaque shape before W1).
export type EncryptedOrderSubmit = SubmitEncryptedOrder;
