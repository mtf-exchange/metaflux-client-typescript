// MTF-native vault action payload types.
//
// Sender-authorized: the recovered signer is the leader / follower. Decimal
// magnitudes (`amount` / `shares`) ride the wire as JSON strings.

/// Kind of vault created by [`CreateVault`]. PascalCase to match the node's
/// vault-kind enum.
export type VaultKind = 'User' | 'Metaliquidity';

/// A vault share count on the WHOLE-share plane, as the exact decimal string the
/// node serves and accepts.
///
/// The brand is a compile-time marker only. At runtime the value is the plain
/// string, so a `WholeShares` goes on the wire unchanged and any `string` still
/// satisfies every existing field. Nothing here is a breaking change.
///
/// The plane is the reason this type exists. Committed state keeps shares as a
/// raw integer on a 10^18 scale, `user_vault_equities` divides by 10^18 before
/// it answers, and `vault_withdraw` reads that same whole-share plane. So the
/// one correct operation on a share string is to pass it through untouched.
/// Scaling it by 10^18 asks to burn 10^18 times too many shares.
export type WholeShares = string & { readonly __brand: 'WholeShares' };

/// Tag a node-served share string as [`WholeShares`] for the wire.
///
/// This is a pure marker: it returns its input. It never rescales, because the
/// node's read plane and its write plane are already the same.
///
/// It rejects a value that cannot be an exact share string — a non-decimal, or
/// one that arrived through `Number` / `parseFloat`. A share count can carry 18
/// fraction digits, which is far past the 15-17 significant digits an IEEE-754
/// double holds, so a float round-trip silently changes the number. Losing the
/// low digits under-burns, but gaining them over-burns, and neither belongs on
/// a redemption.
export function sharesToWire(shares: string): WholeShares {
  if (typeof shares !== 'string') {
    throw new TypeError('shares must be a string; a number cannot hold 18 digits exactly');
  }
  if (shares.includes('e') || shares.includes('E')) {
    throw new TypeError(`shares is in exponent form, which is how a float prints: ${shares}`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(shares)) {
    throw new TypeError(`shares is not a decimal string: ${shares}`);
  }
  return shares as WholeShares;
}

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

/// `vault_distribute` — a follower deposits USD into a vault and receives shares
/// at the current NAV (subject to the per-vault withdrawal lock). Mirrors the
/// node's `core_state` `VaultDistributeParams`; the action envelope wraps this
/// under the key **`params`**.
///
/// **Trap:** the deposit-amount field is named **`pnl`** (a legacy name on the
/// node), NOT `amount`/`deposit`. It is a positive USD amount encoded as a
/// decimal string (the SDK's decimal-on-the-wire convention, matching
/// `vault_transfer` / `vault_withdraw`).
///
/// Forward-compat: the node currently answers this tag with `UnsupportedAction`
/// on the public `/exchange` path; the SDK emits the byte-correct shape the core
/// handler will accept once the bridge lands.
export interface VaultDistribute {
  /// Target vault id (`u64`). Serializes as a bare JSON number.
  vault_id: number;
  /// Deposit amount in USD as a positive decimal string. Node field name is
  /// `pnl` (legacy) — do NOT rename.
  pnl: string;
}
