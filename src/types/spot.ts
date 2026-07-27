// MTF-native spot CLOB (SE-0) action types.
//
// Byte-for-byte mirrors of the server spot action structs. Field ORDER is
// load-bearing for the signed bytes (see `buildNativeSpotOrderAction` /
// `buildNativeSpotCancelAction`).

import type { NativeSide, NativeStpMode, NativeTif } from './trading.js';
import type { U64Input } from '../native/digest.js';

/// MTF-native `spot_order` action shape (SE-0 spot CLOB) — byte-for-byte mirror
/// of the server `NativeSpotOrder`. Spot has no positions, so there is no
/// `reduce_only` / `position_side`. All three time-in-force values work: `ioc`
/// drops the residual, `gtc` and `alo` rest it with escrow.
///
/// Field ORDER is load-bearing for the signed bytes (see `buildNativeSpotOrderAction`).
export interface NativeSpotOrder {
  /// Optional agent-resolved owner (`0x`-hex). With `owner` set, an APPROVED
  /// agent of that account places the order AS the owner; absent, the signer
  /// trades for itself. A present `owner` also enters the EIP-712 digest, so it
  /// must match the bytes that are signed.
  owner?: string;
  /// Spot pair id (`u32`); maps identity → asset id.
  pair: number;
  /// Side: `"bid"` (buy) or `"ask"` (sell).
  side: NativeSide;
  /// Base-asset size in raw lots (`u64` on the wire). Pass a `bigint`/string
  /// above 2^53, or use `szToWire(human, sz_decimals)`.
  size: U64Input;
  /// Limit price in the 1e8 plane (`u64` on the wire). `0` means a MARKET
  /// order, which requires `tif: "ioc"`.
  /// Pass a `bigint`/string above 2^53, or use `pxToWire(humanPrice)`.
  limit_px: U64Input;
  /// Time-in-force. `ioc` drops the residual; `gtc` and `alo` REST it with
  /// escrow. Defaulted to `"ioc"` by the builder.
  tif: NativeTif;
  /// Self-trade-prevention mode.
  stp_mode: NativeStpMode;
  /// Optional `0x`-hex 32-char (16-byte) client order id. Omitted from the
  /// signed bytes entirely when absent.
  cloid?: string;
}

/// MTF-native `spot_cancel` action shape — byte-for-byte mirror of the server
/// `NativeSpotCancel`. Cancels a resting spot order by `oid` (the node cancels
/// by `oid`; there is no cancel-by-cloid on this path).
export interface NativeSpotCancel {
  /// Optional agent-resolved owner (`0x`-hex). With `owner` set, an APPROVED
  /// agent of that account cancels AS the owner; absent, the signer cancels its
  /// own order. A present `owner` also enters the EIP-712 digest.
  owner?: string;
  /// Spot pair id (`u32`).
  pair: number;
  /// Server order id (`u64`) to cancel. REQUIRED.
  oid: number;
}

// ---- Spot margin (leveraged spot) + Earn (lending pool) ----
//
// Available on devnet (preview). Leveraged spot is isolated per `(account,
// pair)`: posted quote collateral is a loss buffer, the borrow funds the buy
// 100%, and the bought base is held segregated on the margin account. Earn is
// the supply side that funds the borrows. All six actions are sender-authorized
// (the recovered signer is the actor — no `owner`). Decimal magnitudes
// (`amount` / `borrow` / `shares`) ride the wire as JSON **strings** to preserve
// fractional precision; `size` / `limit_px` are plain integers on the raw-lot /
// 1e8 planes, like a `NativeSpotOrder`. Field ORDER is load-bearing for the
// signed bytes (see the `buildNativeSpotMargin*` / `buildNativeEarn*` builders).

/**
 * MTF-native `spot_margin_deposit` action params — post quote collateral into
 * the `(account, pair)` margin account.
 *
 * @deprecated DEAD SURFACE. The node rejects `spot_margin_deposit` while
 * cross-margin is active, which on the live chain is from genesis. Collateral is
 * the ONE unified USDC account, so there is no per-pair bucket to fund. Fund the
 * account instead, then use `spot_margin_open`. The type stays because
 * signature reconstruction needs it.
 */
export interface NativeSpotMarginDeposit {
  /// Spot pair id (`u32`).
  pair: number;
  /// Quote collateral to post (whole units), as a decimal string (`> 0`).
  amount: string;
}

/**
 * MTF-native `spot_margin_withdraw` action params — withdraw free collateral
 * back to the spendable quote balance.
 *
 * @deprecated DEAD SURFACE. The node rejects `spot_margin_withdraw` while
 * cross-margin is active, which on the live chain is from genesis. Collateral is
 * the ONE unified USDC account, so there is no per-pair bucket to drain.
 * Withdraw account-wide with `mb_withdraw` instead. The type stays because
 * signature reconstruction needs it.
 */
export interface NativeSpotMarginWithdraw {
  /// Spot pair id (`u32`).
  pair: number;
  /// Collateral to withdraw (whole quote units), as a decimal string (`> 0`).
  amount: string;
}

/// MTF-native `spot_margin_open` action params — borrow quote from the pair's
/// Earn pool and IOC-buy `size` base at up to `limit_px` on leverage. The
/// borrow funds the buy 100%; unspent borrow is repaid instantly.
export interface NativeSpotMarginOpen {
  /// Spot pair id (`u32`).
  pair: number;
  /// Buy size in base raw lots (`u64`).
  size: U64Input;
  /// Limit price in the 1e8 plane (`u64`, `> 0`).
  limit_px: U64Input;
  /// Quote principal to draw from the Earn pool (whole units), as a decimal
  /// string (`> 0`).
  borrow: string;
}

/// MTF-native `spot_margin_close` action params — IOC-sell the held base at no
/// less than `limit_px`, repay principal + interest, return the remainder.
export interface NativeSpotMarginClose {
  /// Spot pair id (`u32`).
  pair: number;
  /// Floor price for the close sell, in the 1e8 plane (`u64`, `> 0`).
  limit_px: U64Input;
}

/// MTF-native `earn_deposit` action params — supply quote into a lending pool
/// for pool shares (1:1 on a fresh pool, else priced off NAV; auto-creates).
export interface NativeEarnDeposit {
  /// Lendable asset id (a spot pair's quote) — the pool key (`u32`).
  asset: number;
  /// Quote to supply (whole units), as a decimal string (`> 0`).
  amount: string;
}

/// MTF-native `earn_withdraw` action params — redeem pool shares back to quote,
/// clamped to the pool's idle liquidity (`supplied − borrowed`).
export interface NativeEarnWithdraw {
  /// Lendable asset id (the pool key) (`u32`).
  asset: number;
  /// Pool shares to redeem, as a decimal string (`> 0`, owned by the sender).
  shares: string;
}
