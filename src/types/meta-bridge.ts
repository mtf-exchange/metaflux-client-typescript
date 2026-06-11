// MTF-native MetaBridge withdrawal action payload types.
//
// Sender-authorized: the signer is the account whose cross-collateral is
// debited. The withdrawal queues an outbound message for validator co-signing,
// which releases funds on the destination chain.

/// Destination chain for a MetaBridge withdrawal. PascalCase to match the
/// node's chain enum.
export type MbChain = 'Base' | 'Arbitrum' | 'Solana';

/// `mb_withdraw` — withdraw cross-collateral to a destination chain.
export interface MbWithdraw {
  /// Destination chain.
  chain: MbChain;
  /// MetaFlux asset id (`u32`; currently only `0` = USDC cross-collateral).
  asset: number;
  /// Amount in base units (`u64`).
  amount: number;
  /// Destination address as `0x`-hex: a 20-byte EVM address (Base / Arbitrum)
  /// or a 32-byte recipient (Solana).
  dst_addr: string;
}
