// MTF-native vault action types (mirror the Rust client `rest/exchange.rs`).
//
// Field ORDER is load-bearing for the signed bytes — it matches the Rust struct
// declaration order (see the `buildNativeVault*Action` builders).

/// MTF-native `vault_create` action payload.
///
/// `{"type":"vault_create","vault":{leader, seed_cents, management_fee_bps}}`.
/// OWNER-CHECKED: `leader` must equal the signing wallet.
export interface VaultCreate {
  /// `0x`-hex 20-byte vault leader. MUST equal the signing wallet.
  leader: string;
  /// Initial seed deposit, USD cents (`u64`).
  seed_cents: number;
  /// Leader management fee in basis points (`u16`, 0..=65535).
  management_fee_bps: number;
}

/// MTF-native `vault_distribute` action payload.
///
/// `{"type":"vault_distribute","params":{vault_id, amount_cents}}`.
/// SENDER-AUTHORIZED (no owner field).
export interface VaultDistribute {
  /// Target vault id (`u64`).
  vault_id: number;
  /// Amount to distribute, USD cents (`u64`).
  amount_cents: number;
}

/// MTF-native `vault_withdraw` action payload.
///
/// `{"type":"vault_withdraw","params":{vault_id, shares}}`.
/// SENDER-AUTHORIZED (no owner field).
export interface VaultWithdraw {
  /// Target vault id (`u64`).
  vault_id: number;
  /// Share count to withdraw — a `u128` emitted as a bare unquoted integer
  /// (serde u128 JSON number form). Validated `>= 0n` and `< 2n**128n`.
  shares: bigint;
}
