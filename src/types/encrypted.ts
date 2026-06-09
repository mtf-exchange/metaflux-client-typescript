// MTF-native encrypted-order action types (mirror the Rust client
// `rest/exchange.rs`). Field ORDER is load-bearing for the signed bytes.

/// MTF-native `encrypted_order_submit` action payload.
///
/// `{"type":"encrypted_order_submit","encrypted":{submitter, ciphertext, threshold, target_block}}`.
/// OWNER-CHECKED: `submitter` must equal the signing wallet.
export interface EncryptedOrderSubmit {
  /// `0x`-hex 20-byte submitter. MUST equal the signing wallet.
  submitter: string;
  /// Encrypted order payload — a `Vec<u8>` emitted as a JSON array of byte
  /// numbers (serde Vec<u8> wire form).
  ciphertext: Uint8Array;
  /// Threshold-decryption threshold (`u8`, 0..=255).
  threshold: number;
  /// Target block height for reveal (`u64`).
  target_block: number;
}
