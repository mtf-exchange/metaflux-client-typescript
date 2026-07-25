// `web_data` — the consolidated account snapshot for `POST /info` and the WS
// `web_data` channel.
//
// One read carries the account facets `account_state` does NOT: vault equities
// and vault summaries, staking, sub-accounts, the multisig signer set, and API
// wallet agents. The node fills each facet with the SAME serializer the
// standalone read uses, so a facet here and its standalone read cannot drift.
//
// Each nested facet drops the redundant per-facet `address`; the snapshot
// carries it once at the top.

import type { StakingState, VaultState } from './core.js';
import type { AgentEntry, SubAccountEntry } from './reads.js';
import type { DelegatorSummary, VaultEquity } from './hl-parity.js';

/// The `vault` facet — what the account holds, and the vaults it follows or
/// leads.
export interface WebDataVault {
  /// Per-vault share / equity rows for the vaults the account deposited into.
  equities: VaultEquity[];
  /// Full `vault_state` bodies for every vault the account follows or leads.
  vaults: VaultState[];
}

/// The `staking` facet — the per-validator detail plus the aggregate summary.
export interface WebDataStaking {
  /// Delegations and pending unstakes, minus the top-level `address`.
  state: Omit<StakingState, 'address'>;
  /// Aggregate staking totals, minus the top-level `address`.
  summary: Omit<DelegatorSummary, 'address'>;
}

/// `web_data` — the consolidated account snapshot keyed by `address`.
///
/// `height` / `time` are FLAT at the top level, not nested under an `as_of`
/// object. Compare `height` across two reads to reject a stale snapshot.
export interface WebData {
  /// Echo of the requested 0x address.
  address: string;
  /// Vault facet.
  vault: WebDataVault;
  /// Staking facet.
  staking: WebDataStaking;
  /// Sub-accounts of the address.
  sub_accounts: SubAccountEntry[];
  /// Multisig config, minus the top-level `address`.
  multisig: {
    /// Whether the account is multisig.
    is_multi_sig: boolean;
    /// M-of-N threshold; `0` if not multisig.
    threshold: number;
    /// Signer set (0x addresses); empty if not multisig.
    signers: string[];
  };
  /// Approved agent / API wallets.
  agents: AgentEntry[];
  /// Committed block height of the snapshot.
  height: number;
  /// Consensus timestamp of that block (unix ms).
  time: number;
}
