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
