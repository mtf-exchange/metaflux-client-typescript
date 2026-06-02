// MTF-native `/info` read API — typed request builders + response shapes.
//
// Byte-for-byte mirror of the server handler
// (`metaflux/crates/api-node/src/rest/info.rs::handle_info`). Every request is
// a `POST /info` whose body is `{"type": "<discriminator>", ...params}` —
// snake_case field names, the same convention the node decodes. The node's
// `/info` surface is MTF-native ONLY; the HL `type` aliases (`meta` etc.) live
// on the gateway's hl_compat layer, not here.
//
// IMPORTANT: the node keys accounts / vaults by internal numeric ids
// (`account_id` u64, `vault_id` u64, `market_id` u32) — NOT `0x` addresses.
// The gateway HL-compat layer translates `user: 0x…` ↔ `account_id`; the
// native node API takes the numeric ids directly.
//
// Numeric fields that can exceed JS `Number.MAX_SAFE_INTEGER` (2^53) are typed
// as `string` here to match the server's decimal-string encoding (`mark_px`,
// `oi`) and avoid silent precision loss. Fields the server emits as JSON
// numbers within safe range (ids, counts, bps, cents) stay `number`.

import { httpRequest } from './http.js';

/// `node_info` — chain identity + sync state. No parameters.
export interface NodeInfo {
  /// EVM chain id pinned at node config.
  chain_id: number;
  /// Current consensus epoch.
  epoch: number;
  /// Committed block height.
  height: number;
  /// Connected gossip peers.
  peers_connected: number;
}

/// `account_state` — account snapshot keyed by internal `account_id`.
export interface AccountState {
  /// Echo of the requested `account_id`.
  account_id: number;
  /// Number of asset clearinghouses where the account holds a non-zero net
  /// position.
  position_count: number;
  /// Native base balance — always `0` on the MTF-native surface (spot
  /// holdings are per-asset; there is no single native base balance).
  balance_base: number;
  /// Cross-account USDC collateral value (truncated toward zero), in whole
  /// quote units.
  balance_quote: number;
}

/// `market_info` — market snapshot keyed by `market_id`.
export interface MarketInfo {
  /// Echo of the requested `market_id`.
  market_id: number;
  /// Mark price as a raw fixed-point magnitude, decimal STRING (may exceed
  /// 2^53 — the gateway applies per-asset tick scaling downstream).
  mark_px: string;
  /// Timestamp (unix ms) of the last trade on this book.
  last_trade_ms: number;
  /// Open interest as a `u128`, decimal STRING (may exceed 2^53).
  oi: string;
}

/// `vault_state` — user-vault snapshot keyed by `vault_id`.
export interface VaultState {
  /// Echo of the requested `vault_id`.
  vault_id: number;
  /// Leader account id (NOT a `0x` address — the gateway translates).
  leader: number;
  /// Sum of all follower shares.
  total_shares: number;
  /// Vault NAV in USD cents (signed — vaults can go negative on backstop
  /// takeovers).
  nav_usd_cents: number;
  /// `true` if the leader has paused the vault.
  paused: boolean;
  /// Leader management fee in bps (pinned 10% = 1000).
  management_fee_bps: number;
  /// Follower withdrawal lock in ms (pinned 4 days = 345_600_000).
  withdrawal_lock_ms: number;
  /// Vault creation timestamp (unix ms).
  created_at_ms: number;
  /// Distinct follower count.
  follower_count: number;
}

/// `staking_state` — staking snapshot keyed by `account_id`.
export interface StakingState {
  /// Echo of the requested `account_id`.
  account_id: number;
  /// Total MTF staked across all delegations.
  total_staked: number;
  /// Accrued but unclaimed validator rewards in MTF.
  pending_rewards: number;
  /// Active per-validator delegations (shape lands server-side; raw for now).
  delegations: unknown[];
  /// Pending unbond entries.
  unbonding: unknown[];
}

/// `fee_schedule` — protocol fee schedule. No parameters. Mirrors the server
/// `handle_fee_schedule` payload (PLAN.md §L.2 + §L.5).
export interface FeeSchedule {
  /// Base taker fee in bps.
  taker_bps: number;
  /// Base maker fee in bps.
  maker_bps: number;
  /// Referrer share of the base taker take, in bps.
  referrer_share_bps: number;
  /// Max additional builder-code fee in bps.
  builder_cap_bps: number;
  /// Max additional MIP-3 deployer fee in bps.
  deployer_cap_bps: number;
  /// Burn fraction of the non-referrer remainder, in bps.
  burn_bps: number;
  /// Vault fraction, in bps.
  vault_bps: number;
  /// Validator fraction, in bps.
  validator_bps: number;
  /// Treasury fraction, in bps.
  treasury_bps: number;
}

/// `/info` namespace handle. Each method POSTs a typed `{"type": ...}` body to
/// `POST <baseUrl>/info` and decodes the JSON response.
///
/// No signing required — these are read-only queries. Construct via
/// `Client.info` or directly with a base URL.
export class InfoApi {
  constructor(private readonly baseUrl: string) {}

  /// `node_info` — chain identity + sync state.
  async nodeInfo(): Promise<NodeInfo> {
    return this.post<NodeInfo>({ type: 'node_info' });
  }

  /// `account_state` — account snapshot by internal `account_id` (u64).
  async accountState(accountId: number): Promise<AccountState> {
    return this.post<AccountState>({
      type: 'account_state',
      account_id: accountId,
    });
  }

  /// `market_info` — market snapshot by `market_id` (u32).
  async marketInfo(marketId: number): Promise<MarketInfo> {
    return this.post<MarketInfo>({ type: 'market_info', market_id: marketId });
  }

  /// `vault_state` — user-vault snapshot by `vault_id` (u64).
  async vaultState(vaultId: number): Promise<VaultState> {
    return this.post<VaultState>({ type: 'vault_state', vault_id: vaultId });
  }

  /// `staking_state` — staking snapshot by internal `account_id` (u64).
  async stakingState(accountId: number): Promise<StakingState> {
    return this.post<StakingState>({
      type: 'staking_state',
      account_id: accountId,
    });
  }

  /// `fee_schedule` — protocol fee schedule.
  async feeSchedule(): Promise<FeeSchedule> {
    return this.post<FeeSchedule>({ type: 'fee_schedule' });
  }

  /// Raw escape hatch — POST an arbitrary `{type, ...}` body to `/info` and
  /// return the parsed JSON. For request shapes the SDK doesn't yet type.
  async raw<T = unknown>(body: { type: string; [k: string]: unknown }): Promise<T> {
    return this.post<T>(body);
  }

  private async post<T>(body: { type: string; [k: string]: unknown }): Promise<T> {
    return httpRequest<T>(this.baseUrl, '/info', { method: 'POST', json: body });
  }
}
