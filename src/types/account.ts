// MTF-native account / margin / agent action payload types.
//
// All sender-authorized: the recovered signer is the account whose state
// mutates, so none carry an `owner` field. Decimal magnitudes (`delta` /
// `amount` / `value`) ride the wire as JSON strings to preserve precision; ids,
// leverage, and bps are plain integers.

/// `update_leverage` — set the per-asset leverage (and optionally flip to
/// isolated margin).
export interface UpdateLeverage {
  /// Target asset / market id (`u32`).
  asset: number;
  /// New leverage multiplier (`u32`, e.g. `10`).
  leverage: number;
  /// `true` also switches the asset to isolated margin.
  is_isolated: boolean;
}

/// `update_isolated_margin` — add or remove isolated margin on an open position.
export interface UpdateIsolatedMargin {
  /// Target asset / market id (`u32`).
  asset: number;
  /// Signed margin delta as a decimal string (`+` adds, `-` withdraws).
  delta: string;
}

/// `top_up_isolated_only_margin` — top up a strict-isolated-only position.
export interface TopUpIsolatedOnlyMargin {
  /// Target asset / market id (`u32`).
  asset: number;
  /// Amount to add, as a positive decimal string.
  amount: string;
}

/// `user_portfolio_margin` — enroll into or out of portfolio margin.
export interface UserPortfolioMargin {
  /// `true` = enroll, `false` = unenroll.
  enroll: boolean;
}

/// `set_display_name` — set the account display name (handle).
export interface SetDisplayName {
  /// Human-readable handle (e.g. `alice.mtf`).
  display_name: string;
}

/// `set_referrer` — set the account referrer (one-time, immutable once set).
export interface SetReferrer {
  /// `0x`-hex 20-byte referrer address.
  referrer: string;
}

/// `approve_agent` — approve an agent wallet to sign on behalf of this account.
export interface ApproveAgent {
  /// `0x`-hex 20-byte agent address.
  agent: string;
  /// Optional human-readable agent label.
  name?: string;
  /// Optional expiry (unix ms). Omit for never-expires.
  expires_at_ms?: number;
}

/// `approve_broker_fee` — approve a broker to charge up to `max_bps` on this
/// account's orders. `max_bps = 0` revokes. The wire key stays `builder`.
export interface ApproveBuilderFee {
  /// `0x`-hex 20-byte broker address.
  builder: string;
  /// Maximum approved fee in basis points (`u16`).
  max_bps: number;
}

/// Canonical name for `ApproveBuilderFee`.
export type ApproveBrokerFee = ApproveBuilderFee;

/// `convert_to_multi_sig_user` — convert the account to an M-of-N multisig.
export interface ConvertToMultiSigUser {
  /// `0x`-hex 20-byte authorized signer addresses.
  signers: string[];
  /// Signature threshold `M` of `signers.length` (`u32`).
  threshold: number;
}

/// `user_set_abstraction` — set a self-scoped abstraction config value.
export interface UserSetAbstraction {
  /// Sub-type tag (`u8`, 0..=255); interpretation is config-defined.
  kind: number;
  /// Setting value as a decimal string.
  value: string;
}

/// `agent_set_abstraction` — an approved agent sets an abstraction config value
/// for `user`. The node verifies the signer is an approved agent of `user`.
export interface AgentSetAbstraction {
  /// `0x`-hex 20-byte account whose config the agent is updating.
  user: string;
  /// Sub-type tag (`u8`, 0..=255).
  kind: number;
  /// Setting value as a decimal string.
  value: string;
}

/// `priority_bid` — pay a priority fee (bps) for block-front placement.
export interface PriorityBid {
  /// Asset this bid is bound to (`u32`).
  asset: number;
  /// Bid in basis points (`u16`).
  bid_bps: number;
}

/// `create_sub_account` — open a sub-account under the sender (the master).
export interface CreateSubAccount {
  /// Human-readable sub-account name.
  name: string;
  /// Optional explicit sub-account index (`u32`). Omit for the next available.
  /// Flattens in the signed digest to a presence `bool` + value (`0` when omitted).
  explicit_index?: number;
  /// Whether the sub-account shares the parent's STP group.
  shared_stp_group: boolean;
}

/// `sub_account_transfer` — move perp cross-collateral between the master and a
/// sub-account.
export interface SubAccountTransfer {
  /// Sub-account index relative to the sender (`u32`).
  sub_index: number;
  /// Direction (`true` = parent → sub, `false` = sub → parent).
  deposit: boolean;
  /// Amount (USDC) as a canonical decimal string.
  amount: string;
}

/// `sub_account_spot_transfer` — move a spot token balance between the master
/// and a sub-account.
export interface SubAccountSpotTransfer {
  /// Sub-account index (`u32`).
  sub_index: number;
  /// Token (spot asset) id (`u32`).
  token: number;
  /// Direction (`true` = parent → sub, `false` = sub → parent).
  deposit: boolean;
  /// Amount as a canonical decimal string.
  amount: string;
}

/// `c_deposit` — move spot MTF into the free staking balance.
export interface CDeposit {
  /// Amount of MTF to move (positive), as a canonical decimal string.
  amount: string;
}

/// `c_withdraw` — move the free staking balance back to spot MTF.
export interface CWithdraw {
  /// Amount of MTF to move (positive), as a canonical decimal string.
  amount: string;
}

/// `core_evm_transfer` — move a Core spot token to MetaFluxEVM.
///
/// Core → EVM only on `/exchange`: debits the sender's Core balance for `asset`
/// (omit / `0` = USDC cross-collateral; any other id = its spot balance, which
/// must be linked to an EVM contract) and mints the scale-converted token to
/// `destination` on the next EVM block. `to_evm: false` (EVM → Core) is rejected
/// — that direction originates as an EVM burn tx. Sender-authorized. Typed-only.
export interface CoreEvmTransfer {
  /// Amount in the whole-token plane as a canonical decimal string.
  amount: string;
  /// Direction. `true` = Core → EVM (the only supported direction here).
  to_evm: boolean;
  /// `0x`-hex 20-byte EVM-side recipient.
  destination: string;
  /// MTF asset id to move (omit / `0` = USDC). Part of the signed digest, so a
  /// relay can't redirect the transfer to a different spot token.
  asset?: number;
  /// EVM calldata run against `destination` AFTER the credit lands, as a real
  /// transaction with its own receipt.
  ///
  /// A reverting payload NEVER unwinds the credit: Core was debited, the EVM
  /// was credited, and the call is additional. Read its receipt.
  ///
  /// **Presence selects the signing type.** Including this key — even as an
  /// empty array — signs under `CoreEvmTransferV2`.
  data?: number[];
  /// Delivery chain. `0` or the local EVM chain id only; anything else is
  /// rejected, because cross-chain delivery is not built. The field exists so
  /// the capability has a signed slot.
  ///
  /// **Presence selects the signing type.** Including this key — even as `0` —
  /// signs under `CoreEvmTransferV2`.
  destination_chain_id?: number;
}

/// `send_to_evm_with_data` — move a Core spot token to MetaFluxEVM with an EVM
/// payload.
///
/// ⚠️ **NOT LIVE YET.** The deployed exchange still answers
/// `sendToEvmWithData is retired; use coreEvmTransfer` with a 400. This type and
/// its signing path ship ahead of that, so a signature you build today is correct
/// and the request is refused until the next exchange release. Use
/// `coreEvmTransfer` in the meantime.
///
/// Core → EVM only. The action debits the sender's Core balance for `token`,
/// mints the scale-converted token to `destination_recipient` on the next EVM
/// block, then runs `data` against that address. Sender-authorized. Typed-only.
///
/// `coreEvmTransfer` moves the same value with the same payload rules. This
/// action adds three extra signed slots — `source_dex`, `to_perp` and
/// `destination_chain_id`. **Each of the three refuses any value it cannot
/// honour; it is never accepted and then ignored.** A historical payload that
/// carries `source_dex: 1` is therefore rejected today. Read the field rules
/// below before you re-send one.
export interface SendToEvmWithData {
  /// MTF token id to move. Every accepted token debits that token's SPOT balance.
  ///
  /// The token must be linked to an EVM contract, or be the native gas token. An
  /// unlinked token is rejected — the credit would otherwise mint the gas token
  /// against a debit of something else.
  ///
  /// **Token `100` (spot USDC) is REJECTED** as unlinked. It carries no EVM
  /// contract link, and admitting it would queue a credit the exchange cannot
  /// resolve to a contract. So this action cannot move USDC that backs an open
  /// position — use `coreEvmTransfer` with `asset: 0`, which is the lane that
  /// spends the collateral pool and is gated on free collateral.
  token: number;
  /// Amount in the whole-token plane as a canonical decimal string. Must be
  /// positive.
  ///
  /// The lane truncates the amount toward zero twice: to 8 decimal places, then
  /// to the token's own EVM decimals. The debit equals the truncated credit, so
  /// the remainder stays in your Core balance. **An amount that truncates to a
  /// ZERO credit is rejected** — it would debit Core and credit nothing.
  amount: string;
  /// Source DEX id. **`0` only** (the default). The action debits one ledger, so
  /// no other value is honourable and any other value is rejected.
  source_dex?: number;
  /// `0x`-hex 20-byte EVM-side recipient. The EVM side has no owner check: the
  /// credit is a mint to this address, so a wrong address is not recoverable.
  destination_recipient: string;
  /// Credit a perp account on the EVM side. **`false` only** (the default). The
  /// EVM side has no perp account, so `true` is rejected.
  to_perp?: boolean;
  /// Delivery chain. **`0` (the default) or the local EVM chain id only.** Any
  /// other id is rejected, because cross-chain delivery is not built. The field
  /// exists so the capability has a signed slot.
  destination_chain_id?: number;
  /// EVM calldata run against `destination_recipient` AFTER the credit lands, as
  /// a real transaction with its own receipt. Up to 4096 bytes; a longer payload
  /// is rejected.
  ///
  /// A reverting payload NEVER unwinds the credit: Core was debited, the EVM was
  /// credited, and the call is additional. Read its receipt.
  data: number[];
  /// Transfer tag carried into the queued transfer, signed as `transferNonce`.
  ///
  /// This is NOT the replay guard. The envelope nonce (`opts.nonce`) is the one
  /// the node checks and advances. Defaults to `0`.
  nonce?: number | bigint;
}
