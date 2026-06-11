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

/// `approve_builder_fee` — approve a builder to charge up to `max_bps` on this
/// account's orders. `max_bps = 0` revokes.
export interface ApproveBuilderFee {
  /// `0x`-hex 20-byte builder address.
  builder: string;
  /// Maximum approved fee in basis points (`u16`).
  max_bps: number;
}

/// `convert_to_multi_sig_user` — convert the account to an M-of-N multisig.
export interface ConvertToMultiSigUser {
  /// `0x`-hex 20-byte authorized signer addresses.
  signers: string[];
  /// Signature threshold `M` of `signers.length` (`u32`).
  threshold: number;
}

/// `user_dex_abstraction` — toggle the account's DEX-abstraction opt-in flag.
export interface UserDexAbstraction {
  /// `true` = opt in, `false` = opt out.
  enabled: boolean;
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
