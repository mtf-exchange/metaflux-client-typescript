// Custody-bridge response interfaces for `POST /info`.
//
// Source of truth: the KB spec metaflux-knowledges/docs/api/rest/info/bridge.md.
// Field names are the exact snake_case keys the node emits inside
// `{type, data}.data`. Money magnitudes that can exceed 2^53 are typed `string`.
//
// Two PUBLIC queries are typed here: `bridge_chain_configs` and
// `bridge_user_outbox`. The node also serves `bridge_outbox` and
// `bridge_finalized_cosignatures`, but the public gateway REFUSES both (they
// are operator reads), so this SDK does not type them.
//
// THE MESSAGE ID MOVES. A withdrawal's `message_id` is the SIGNING digest, and
// it folds the chain's committed deployment row (`evm_chain_id`,
// `evm_contract_address`, `validator_set_epoch`). Governance can rotate that
// row, and the same withdrawal then gets a NEW `message_id`. The value on
// `BridgeOutboxEntry.message_id` is always the id under the CURRENT row.

/// Where one pending withdrawal stands against the CURRENT deployment.
///
/// - `awaiting_cosignatures` — validators are still co-signing. Normal, and it
///   SURVIVES a deployment rotation: the relay re-derives the new id and
///   re-signs under it. Only partial-signature progress resets.
/// - `ready_to_release` — a releasable ⅔ multisig exists under the current
///   deployment. The relay can submit it now. The ONLY status a rotation can
///   break.
/// - `stranded_on_retired_domain` — quorum was reached under a RETIRED
///   deployment. The replay guard keys on a rotation-invariant id, so the chain
///   deliberately refuses to re-finalize under the new deployment and no
///   releasable multisig can ever appear. TERMINAL: waiting does not clear it
///   and no relay action can; recovery needs a governance re-credit vote.
/// - `released` — the destination-chain release is quorum-confirmed. The entry
///   is retained for the chain's release-retention window so a destination
///   reorg can be re-relayed, then it leaves the outbox.
export type BridgeOutboxStatus =
  | 'awaiting_cosignatures'
  | 'ready_to_release'
  | 'stranded_on_retired_domain'
  | 'released';

/// One pending withdrawal in the bridge outbox.
export interface BridgeOutboxEntry {
  /// Destination chain: `1` = Base, `2` = Arbitrum.
  chain: number;
  /// MetaFlux asset id.
  asset: number;
  /// Spot-token symbol for `asset`.
  token: string;
  /// Amount in the destination chain's BASE UNITS, not whole coins — USDC has 6
  /// decimals, so `"1000000"` is 1.0 USDC. A string because the value is a
  /// `u128` and does not fit a JS number.
  amount_units: string;
  /// 32-byte destination address (`0x` + 64 hex; an EVM address is left-padded).
  dst_addr: string;
  /// Anti-replay nonce.
  nonce: number;
  /// Consensus ts the withdrawal was queued (ms).
  ts_ms: number;
  /// The CURRENT-domain signing digest (`0x` + 64 hex). See the file header:
  /// this value moves when governance rotates the deployment.
  message_id: string;
  /// Where the entry stands against the current deployment.
  status: BridgeOutboxStatus;
  /// Validators that have co-signed so far. Only meaningful while
  /// `awaiting_cosignatures`.
  pending_cosigner_count: number;
  /// Release ts (ms) for a `released` entry; `null` for every other status.
  released_at_ms: number | null;
}

/// One user's pending bridge withdrawals (`bridge_user_outbox`).
export interface BridgeUserOutbox {
  /// Pending withdrawals, oldest first. Empty means no withdrawal is in flight
  /// — it does NOT mean a past withdrawal failed.
  entries: BridgeOutboxEntry[];
  /// `true` if the 256-entry cap truncated the list.
  truncated: boolean;
}

/// The governed deposit-scan policy on one chain.
export interface BridgeScanPolicy {
  /// `false` = the scan keeps the finalized floor. Not a setting a real-funds
  /// chain changes.
  confirmations_only: boolean;
  /// RAW confirmations lag. `0` means UNSET — read `effective_confirmations`
  /// for the value in force.
  confirmations: number;
  /// The confirmations lag actually in force (default `5`).
  effective_confirmations: number;
  /// Reorg depth, read ONLY while `confirmations_only` is `true`.
  confirmations_only_depth: number;
  /// The USDC ERC-20 the raw-transfer deposit lane credits (`0x` + 40 hex).
  /// Zero disables the lane.
  usdc_token: string;
  /// Master switch for the raw-transfer (credit-the-sender) deposit lane.
  raw_transfer_credit: boolean;
}

/// One chain's committed bridge deployment row.
///
/// The `(evm_chain_id, evm_contract_address, validator_set_epoch)` triple IS the
/// message-id domain. Rotating any of the three moves the `message_id` of every
/// in-flight withdrawal on that chain.
export interface BridgeChainConfigRow {
  /// `1` = Base, `2` = Arbitrum.
  chain: number;
  /// 32-byte deployment id (`0x` + 64 hex) — the EVM address left-padded.
  contract_address: string;
  /// Stake share required to co-sign, in basis points (`6700` = 67%).
  validator_quorum_threshold_bps: number;
  /// Per-chain replay counter, shared by both directions.
  replay_nonce: number;
  /// Per-chain kill switch. Blocks withdrawals AND deposit attestation.
  paused: boolean;
  /// EVM `block.chainid` of the deployed contract.
  evm_chain_id: number;
  /// 20-byte `address(this)` of the deployed contract (`0x` + 40 hex).
  evm_contract_address: string;
  /// Validator-set epoch the deployed contract pins.
  validator_set_epoch: number;
  /// RAW retention window (ms). `0` means UNSET — read
  /// `effective_release_retention_ms` for the window in force.
  release_retention_ms: number;
  /// The release-retention window actually in force (default 24 h). A released
  /// entry stays in the outbox this long so a destination reorg can be
  /// re-relayed.
  effective_release_retention_ms: number;
  /// The governed deposit-scan policy.
  scan_policy: BridgeScanPolicy;
}

/// Every committed bridge deployment row (`bridge_chain_configs`).
export interface BridgeChainConfigs {
  /// Chain-wide refusal of NEW withdrawals, all chains, until governance clears
  /// it. A bridge can be unable to PAY while still able to ACCEPT; this flag
  /// stops the accept.
  withdrawals_halted: boolean;
  /// One row per configured chain.
  configs: BridgeChainConfigRow[];
}
