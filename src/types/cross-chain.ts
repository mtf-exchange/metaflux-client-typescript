// MTF-native cross-chain action types (mirror the Rust client
// `rest/exchange.rs`). Field ORDER is load-bearing for the signed bytes.

/// MTF-native `cross_chain_send` action payload.
///
/// `{"type":"cross_chain_send","msg":{sender, dst_chain, dst_address, asset, amount, nonce}}`.
/// OWNER-CHECKED: `sender` must equal the signing wallet.
export interface CrossChainSend {
  /// `0x`-hex 20-byte sender. MUST equal the signing wallet.
  sender: string;
  /// Destination chain id (`u32`).
  dst_chain: number;
  /// `0x`-hex 20-byte destination address.
  dst_address: string;
  /// Asset symbol, length 1..=12 (JSON-escaped on the wire).
  asset: string;
  /// Amount to send — a `u128` emitted as a bare unquoted integer (serde u128
  /// JSON number form). Validated `< 2n**128n`.
  amount: bigint;
  /// The action's OWN nonce (`u64`) — distinct from the EIP-712 replay nonce.
  nonce: number;
}
