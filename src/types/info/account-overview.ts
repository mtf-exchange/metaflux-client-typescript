// The `account_state` `detail: "overview"` shape — the account's full
// NON-TRADING state, for `POST /info`.
//
// The companion shape to `AccountState`: the default depth owns margin,
// positions and the token ledger, this one owns vault equities and vault
// summaries, staking, sub-accounts, the multisig signer set, API-wallet agents,
// and the derived role. The node fills each facet with the SAME serializer the
// facet's own builder uses, so a facet here cannot drift from the rest of the
// surface.
//
// Each nested facet drops the redundant per-facet `address`; the snapshot
// carries it once at the top. Every sub-object is honest-empty, never absent.
//
// The standalone `account_overview` `/info` type was REMOVED server-side.
// `info.accountOverview()` posts the `detail` parameter and returns this shape.
// The WS `account_state` frame carries the DEFAULT depth only — these facets
// are REST-read, not pushed.

import type { StakingState, VaultState } from './core.js';
import type { AgentEntry, SubAccountEntry } from './reads.js';
import type { DelegatorSummary, VaultEquity } from './hl-parity.js';

/// The derived account role, from the precedence `vault` -> `sub_account` ->
/// `agent` -> `user` -> `missing`.
export type AccountRole =
  | 'missing'
  | 'user'
  | 'agent'
  | 'vault'
  | 'sub_account';

/// The `vault` facet — what the account holds, and the vaults it follows or
/// leads.
export interface AccountOverviewVault {
  /// Per-vault share / equity rows for the vaults the account deposited into.
  equities: VaultEquity[];
  /// Full `vault_state` bodies for every vault the account follows or leads. A
  /// leader with no deposit of their own still gets a row.
  vaults: VaultState[];
}

/// The `staking` facet — the per-validator detail plus the aggregate summary.
export interface AccountOverviewStaking {
  /// Delegations and pending unstakes, minus the top-level `address`.
  state: Omit<StakingState, 'address'>;
  /// Aggregate staking totals, minus the top-level `address`.
  summary: Omit<DelegatorSummary, 'address'>;
}

/// The `detail: "overview"` shape of `account_state`, keyed by `address`.
///
/// `height` / `time` are FLAT at the top level, not nested under an `as_of`
/// object. Compare `height` across two reads to reject a stale snapshot.
export interface AccountOverview {
  /// Echo of the requested 0x address.
  address: string;
  /// Derived account role. Absent on a node that predates the field.
  role?: AccountRole;
  /// Vault facet.
  vault: AccountOverviewVault;
  /// Staking facet.
  staking: AccountOverviewStaking;
  /// Sub-accounts of the address, in index order. `equity` counts unrealised
  /// PnL, so a sub deep in loss reads DOWN here rather than at its settled
  /// cash — which is how a parent spots the one near liquidation.
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
