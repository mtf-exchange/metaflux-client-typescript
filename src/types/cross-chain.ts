// MTF-native cross-chain action payload type.
//
// Forward-compat: the node recognizes the `cross_chain_send` action tag but
// currently lowers it to `UnsupportedAction` on the public `/exchange` path
// (the real handler runs on the EVM core-writer path). The SDK emits the
// byte-correct shape the node's `evm_integration` `CrossChainSendParams`
// decoder expects, so it goes live the moment the node bridges it.

/// `cross_chain_send` — initiate a chain-agnostic cross-chain transfer (queued
/// to the bridge outbox). Mirrors the node's `evm_integration`
/// `CrossChainSendParams`. The action envelope wraps this under the key **`msg`**.
///
/// Traps: the action field is `dst_chain_id` (the read-only `CrossChainMsg`
/// snapshot uses `dst_chain`); under the node's plain `#[derive(Serialize)]`,
/// `recipient: [u8; 32]` is a JSON **array of 32 byte-numbers** and `amount`
/// (`u128`) is a JSON **number** — NOT 0x-hex strings.
export interface CrossChainSend {
  /// Destination chain id (`u32`).
  dst_chain_id: number;
  /// Chain-agnostic 32-byte recipient (EVM = left-padded 20-byte address).
  /// Serializes as a JSON array of 32 byte-numbers — pass a 32-byte
  /// `Uint8Array`.
  recipient: Uint8Array;
  /// MTF asset id (`u32`) — NOT a destination-chain token address.
  token: number;
  /// Amount in the MTF asset's native fixed-point (`u128`). `bigint` — emitted
  /// as a bare JSON number, NOT hex.
  amount: bigint;
  /// Application-supplied idempotency nonce (`u64`); `(sender, nonce)` is the
  /// key.
  nonce: number;
}
