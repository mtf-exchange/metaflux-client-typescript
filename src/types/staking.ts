// MTF-native staking action payload types.
//
// All sender-authorized (the recovered signer is the staking account). `amount`
// rides the wire as a decimal string.

/// `token_delegate` — delegate stake to a validator, or queue an undelegation.
export interface TokenDelegate {
  /// `0x`-hex 20-byte validator address.
  validator: string;
  /// Stake amount as a decimal string.
  amount: string;
  /// `true` = unstake / queue undelegation; `false` = delegate.
  is_undelegate: boolean;
  /// Lock tier in months — one of `0` (flexible), `1`, `6`, `24`. Optional;
  /// defaults to `0` (flexible), matching the server's `#[serde(default)]`. The
  /// typed digest ALWAYS signs `lockMonths` (default 0) so a relay cannot alter
  /// the delegation's lock tier / reward weight. Ignored on undelegate.
  lock_months?: number;
}

/// `claim_rewards` — claim accrued staking rewards.
export interface ClaimRewards {
  /// `0x`-hex 20-byte validator to claim from. Omit to claim across all
  /// delegations.
  validator?: string;
}

/// `link_staking_user` — alias another account as this account's staking target.
export interface LinkStakingUser {
  /// `0x`-hex 20-byte staking target address.
  target: string;
}
