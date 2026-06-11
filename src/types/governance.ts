// MTF-native governance / operator action payload types.
//
// Sender-authorized, with action-level authorization enforced by the node at
// dispatch: `set_metaliquidity_whitelist` requires validator membership, and
// `register_metaliquidity_operator` requires the signer to be the vault leader.

/// `set_metaliquidity_whitelist` — set an MLP whitelist membership (validator
/// vote).
export interface SetMetaliquidityWhitelist {
  /// `0x`-hex 20-byte address whose membership is being set.
  address: string;
  /// `true` adds to the whitelist, `false` removes.
  allowed: boolean;
}

/// `register_metaliquidity_operator` — register or revoke an external strategy
/// operator for a vault.
export interface RegisterMetaliquidityOperator {
  /// Target vault id (`u64`).
  vault_id: number;
  /// `0x`-hex 20-byte operator address.
  operator: string;
  /// `true` registers, `false` revokes.
  allowed: boolean;
  /// Optional expiry (unix ms). Omit for never-expires.
  expires_at_ms?: number;
}
