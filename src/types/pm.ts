// MTF-native portfolio-margin action types (mirror the Rust client
// `rest/exchange.rs`). Each carries the single `user` field.

/// MTF-native `pm_enroll` action payload.
///
/// `{"type":"pm_enroll","params":{user}}`. OWNER-CHECKED: `user` must equal the
/// signing wallet. Opts the account into portfolio margin.
export interface PmEnroll {
  /// `0x`-hex 20-byte account. MUST equal the signing wallet.
  user: string;
}

/// MTF-native `pm_unenroll` action payload.
///
/// `{"type":"pm_unenroll","params":{user}}`. OWNER-CHECKED: `user` must equal
/// the signing wallet. Opts the account back out of portfolio margin.
export interface PmUnenroll {
  /// `0x`-hex 20-byte account. MUST equal the signing wallet.
  user: string;
}

/// MTF-native `pm_rebalance` action payload.
///
/// `{"type":"pm_rebalance","params":{user}}`. SENDER-AUTHORIZED. Triggers a
/// portfolio-margin rebalance for `user`.
export interface PmRebalance {
  /// `0x`-hex 20-byte account to rebalance.
  user: string;
}
