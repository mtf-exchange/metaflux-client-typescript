// MTF-native vault action payload types.
//
// Sender-authorized: the recovered signer is the leader / follower. Decimal
// magnitudes (`amount` / `shares`) ride the wire as JSON strings.

/// Kind of vault created by [`CreateVault`]. PascalCase to match the node's
/// vault-kind enum.
export type VaultKind = 'User' | 'Metaliquidity';

/// `create_vault` — create a new vault. The signing wallet becomes the leader.
export interface CreateVault {
  /// Display name.
  name: string;
  /// Follower withdrawal lock period in seconds (`u64`).
  lock_period_secs: number;
  /// Optional parent vault id (`u64`).
  parent?: number;
  /// Vault kind. Defaults to `"User"` when omitted.
  kind?: VaultKind;
}

/// `vault_transfer` — leader moves capital into (`deposit: true`) or out of
/// (`deposit: false`) a vault.
export interface VaultTransfer {
  /// Target vault id (`u64`).
  vault_id: number;
  /// `true` = deposit (leader → vault), `false` = withdraw (vault → leader).
  deposit: boolean;
  /// Amount in USD as a decimal string.
  amount: string;
}

/// `vault_modify` — leader updates vault configuration. An omitted field is
/// left unchanged.
export interface VaultModify {
  /// Target vault id (`u64`).
  vault_id: number;
  /// New display name.
  new_name?: string;
  /// New lock period in seconds (`u64`).
  new_lock_period_secs?: number;
  /// New management fee in bps (`u16`).
  new_management_fee_bps?: number;
  /// New paused flag.
  new_paused?: boolean;
}

/// `vault_withdraw` — follower redeems shares from a vault (subject to the
/// per-vault lock).
export interface VaultWithdraw {
  /// Target vault id (`u64`).
  vault_id: number;
  /// Shares to redeem, as a decimal string.
  shares: string;
}
