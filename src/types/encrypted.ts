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
