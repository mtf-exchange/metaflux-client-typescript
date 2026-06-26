// MTF-native signed-action builders — hand-built canonical snake_case JSON.
//
// Each `build*Action(payload): string` produces the EXACT bytes that are BOTH
// signed (`signNativeAction`) and POSTed verbatim (`nativeRequestBody`). The
// same string is signed and sent, so the server verifies the signature over
// identical bytes (it parses `action` as `serde_json::value::RawValue`); never
// re-stringify a parsed object.
//
// The 5 original builders (submit_order / cancel_order / set_position_mode /
// spot_order / spot_cancel) are byte-pinned by `__tests__/native.test.ts`.

import {
  jsonStr,
  validateAddress,
  validateCloid,
  validateDecimalString,
  validateI128,
  validateMarket,
  validateU8,
  validateU16,
  validateU32,
  validateU64,
  validateU128,
  toU64,
} from './digest.js';
import type {
  AgentSetAbstraction,
  ApproveAgent,
  ApproveBuilderFee,
  BatchCancel,
  BatchModify,
  BatchOrder,
  CancelAllOrders,
  CancelByCloid,
  ClaimRewards,
  ConvertToMultiSigUser,
  CoreSide,
  CreateVault,
  CrossChainSend,
  EncryptedOrderSubmit,
  FbaSubmit,
  LinkStakingUser,
  MbWithdraw,
  Modify,
  NativeBuilder,
  NativeCancel,
  NativeEarnDeposit,
  NativeEarnWithdraw,
  NativeOrder,
  NativeSetPositionMode,
  NativeSpotCancel,
  NativeSpotMarginClose,
  NativeSpotMarginDeposit,
  NativeSpotMarginOpen,
  NativeSpotMarginWithdraw,
  NativeSpotOrder,
  NativeTrigger,
  PriorityBid,
  RegisterMetaliquidityOperator,
  RfqAccept,
  RfqRequest,
  ScheduleCancel,
  SetDisplayName,
  SetMetaliquidityWhitelist,
  SetReferrer,
  SubmitEncryptedOrder,
  TokenDelegate,
  TopUpIsolatedOnlyMargin,
  TwapCancel,
  TwapOrder,
  UpdateIsolatedMargin,
  UpdateLeverage,
  UserDexAbstraction,
  UserPortfolioMargin,
  UserSetAbstraction,
  VaultDistribute,
  VaultModify,
  VaultTransfer,
  VaultWithdraw,
} from '../types/index.js';

/// Build the canonical native `submit_order` action JSON string.
///
/// Field order mirrors the server `NativeOrder` exactly. Optional `cloid` /
/// `builder` are omitted entirely when absent (matching the server's
/// `#[serde(default)]` + KAT vector, where neither appears). The returned
/// string is BOTH what gets signed and what gets sent — do not re-serialize.
export function buildNativeOrderAction(order: NativeOrder): string {
  validateAddress(order.owner, 'owner');
  validateMarket(order.market);
  validateU64(order.size, 'size');
  validateU64(order.limit_px, 'limit_px');

  const parts: string[] = [
    `${jsonStr('owner')}:${jsonStr(order.owner)}`,
    `${jsonStr('market')}:${order.market}`,
    `${jsonStr('side')}:${jsonStr(order.side)}`,
    `${jsonStr('kind')}:${jsonStr(order.kind)}`,
    `${jsonStr('size')}:${toU64(order.size, 'size')}`,
    `${jsonStr('limit_px')}:${toU64(order.limit_px, 'limit_px')}`,
    `${jsonStr('tif')}:${jsonStr(order.tif)}`,
    `${jsonStr('stp_mode')}:${jsonStr(order.stp_mode)}`,
    `${jsonStr('reduce_only')}:${order.reduce_only ? 'true' : 'false'}`,
  ];
  if (order.cloid !== undefined) {
    validateCloid(order.cloid);
    parts.push(`${jsonStr('cloid')}:${jsonStr(order.cloid)}`);
  }
  if (order.builder !== undefined) {
    parts.push(`${jsonStr('builder')}:${buildBuilder(order.builder)}`);
  }
  // HEDGE MODE: `position_side` is OMITTED on a one-way account so the signed
  // bytes stay byte-identical to a pre-hedge SDK; it rides last (after
  // cloid/builder), matching the server `NativeOrder` field declaration order.
  if (order.position_side !== undefined) {
    parts.push(`${jsonStr('position_side')}:${jsonStr(order.position_side)}`);
  }
  // TP/SL trigger block rides last (after position_side), matching the server
  // `NativeOrder` field declaration order; omitted entirely when absent.
  if (order.trigger !== undefined) {
    parts.push(`${jsonStr('trigger')}:${buildTrigger(order.trigger)}`);
  }
  const orderJson = `{${parts.join(',')}}`;
  return `{${jsonStr('type')}:${jsonStr('submit_order')},${jsonStr('order')}:${orderJson}}`;
}

/// Serialize a TP/SL trigger block in the server-expected
/// `{trigger_px, is_market, tpsl}` order. `tpsl` is `"tp"` / `"sl"`.
function buildTrigger(t: NativeTrigger): string {
  validateU64(t.trigger_px, 'trigger.trigger_px');
  if (t.tpsl !== 'tp' && t.tpsl !== 'sl') {
    throw new RangeError('trigger.tpsl must be "tp" or "sl"');
  }
  return `{${jsonStr('trigger_px')}:${toU64(t.trigger_px, 'trigger.trigger_px')},${jsonStr('is_market')}:${t.is_market ? 'true' : 'false'},${jsonStr('tpsl')}:${jsonStr(t.tpsl)}}`;
}

/// Serialize a builder carve in the server-expected `{fee, user}` order.
function buildBuilder(b: NativeBuilder): string {
  if (!Number.isInteger(b.fee) || b.fee < 0 || b.fee > 0xffff) {
    throw new RangeError('builder.fee must be a u16 (0..=65535)');
  }
  validateAddress(b.user, 'builder.user');
  return `{${jsonStr('fee')}:${b.fee},${jsonStr('user')}:${jsonStr(b.user)}}`;
}

/// Build the canonical native `cancel_order` action JSON string.
///
/// Field order mirrors the server `NativeCancel`: `owner`, `market`, then `oid`
/// / `cloid` when present. The server's `CancelParams` bridge cancels by `oid`,
/// so an `oid` is REQUIRED for the cancel to lower successfully (a `cloid`-only
/// cancel is accepted on the wire but rejected at lowering with
/// `CancelMissingOid`); we still emit either form so the bytes stay
/// caller-controlled. The returned string is BOTH signed and sent.
export function buildNativeCancelAction(cancel: NativeCancel): string {
  validateAddress(cancel.owner, 'owner');
  validateMarket(cancel.market);
  if (cancel.oid === undefined && cancel.cloid === undefined) {
    throw new RangeError('cancel requires an oid (server cancels by oid)');
  }
  const parts: string[] = [
    `${jsonStr('owner')}:${jsonStr(cancel.owner)}`,
    `${jsonStr('market')}:${cancel.market}`,
  ];
  if (cancel.oid !== undefined) {
    validateU64(cancel.oid, 'oid');
    parts.push(`${jsonStr('oid')}:${cancel.oid}`);
  }
  if (cancel.cloid !== undefined) {
    validateCloid(cancel.cloid);
    parts.push(`${jsonStr('cloid')}:${jsonStr(cancel.cloid)}`);
  }
  const cancelJson = `{${parts.join(',')}}`;
  return `{${jsonStr('type')}:${jsonStr('cancel_order')},${jsonStr('cancel')}:${cancelJson}}`;
}

/// Build the canonical native `set_position_mode` action JSON string.
///
/// `{"type":"set_position_mode","params":{"hedge":<bool>}}` — toggles the
/// account between one-way (`false`) and hedge / two-way (`true`). Sender-
/// authorized: the recovered signer IS the account (no `owner`), so this is
/// signed exactly like the order builders and POSTed verbatim. The node only
/// permits the switch while flat on every market.
export function buildNativeSetPositionModeAction(
  mode: NativeSetPositionMode,
): string {
  if (typeof mode.hedge !== 'boolean') {
    throw new RangeError('set_position_mode: hedge must be a boolean');
  }
  const paramsJson = `{${jsonStr('hedge')}:${mode.hedge ? 'true' : 'false'}}`;
  return `{${jsonStr('type')}:${jsonStr('set_position_mode')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `spot_order` action JSON string (spot CLOB).
///
/// Field order mirrors the server `NativeSpotOrder` exactly. `tif` defaults to
/// `"ioc"` because v0 accepts ONLY IOC limit orders (`tif:"ioc"` + `limit_px > 0`);
/// the node rejects Gtc / Alo and a zero (market) price. Sender-authorized (no
/// `owner`); the returned string is BOTH signed and sent.
export function buildNativeSpotOrderAction(order: NativeSpotOrder): string {
  validateMarket(order.pair);
  validateU64(order.size, 'size');
  validateU64(order.limit_px, 'limit_px');
  // v0 constraint: IOC limit only, strictly-positive price. The node enforces
  // both; we fail loud here so a misconfigured order never reaches the wire.
  const tif = order.tif ?? 'ioc';
  if (tif !== 'ioc') {
    throw new RangeError('spot_order v0 requires tif="ioc" (Gtc/Alo rejected)');
  }
  if (toU64(order.limit_px, 'limit_px') <= 0n) {
    throw new RangeError('spot_order v0 requires limit_px > 0 (market px rejected)');
  }
  const parts: string[] = [
    `${jsonStr('pair')}:${order.pair}`,
    `${jsonStr('side')}:${jsonStr(order.side)}`,
    `${jsonStr('size')}:${toU64(order.size, 'size')}`,
    `${jsonStr('limit_px')}:${toU64(order.limit_px, 'limit_px')}`,
    `${jsonStr('tif')}:${jsonStr(tif)}`,
    `${jsonStr('stp_mode')}:${jsonStr(order.stp_mode)}`,
  ];
  if (order.cloid !== undefined) {
    validateCloid(order.cloid);
    parts.push(`${jsonStr('cloid')}:${jsonStr(order.cloid)}`);
  }
  const orderJson = `{${parts.join(',')}}`;
  return `{${jsonStr('type')}:${jsonStr('spot_order')},${jsonStr('order')}:${orderJson}}`;
}

/// Build the canonical native `spot_cancel` action JSON string.
///
/// `{"type":"spot_cancel","cancel":{"pair":<u32>,"oid":<u64>}}`. The node
/// cancels a resting spot order by `oid`, so `oid` is REQUIRED. Field order
/// mirrors the server `NativeSpotCancel`; the returned string is signed and sent.
export function buildNativeSpotCancelAction(cancel: NativeSpotCancel): string {
  validateMarket(cancel.pair);
  validateU64(cancel.oid, 'oid');
  const cancelJson = `{${jsonStr('pair')}:${cancel.pair},${jsonStr('oid')}:${cancel.oid}}`;
  return `{${jsonStr('type')}:${jsonStr('spot_cancel')},${jsonStr('cancel')}:${cancelJson}}`;
}

// ============================================================================
// Real node /exchange write actions. Each hand-builds canonical snake_case JSON
// (the same string is signed and POSTed). All are sender-authorized (no `owner`
// field) except the inner orders/cancels of batch_order / batch_cancel, which
// carry an `owner` the client checks against the recovered signer.
// ============================================================================

/// Build the inner `{...}` body of one perp order (the value under `order` in
/// submit_order, and each element of a batch_order). Mirrors `NativeOrder`.
function buildOrderBody(order: NativeOrder): string {
  validateAddress(order.owner, 'owner');
  validateMarket(order.market);
  validateU64(order.size, 'size');
  validateU64(order.limit_px, 'limit_px');
  const parts: string[] = [
    `${jsonStr('owner')}:${jsonStr(order.owner)}`,
    `${jsonStr('market')}:${order.market}`,
    `${jsonStr('side')}:${jsonStr(order.side)}`,
    `${jsonStr('kind')}:${jsonStr(order.kind)}`,
    `${jsonStr('size')}:${toU64(order.size, 'size')}`,
    `${jsonStr('limit_px')}:${toU64(order.limit_px, 'limit_px')}`,
    `${jsonStr('tif')}:${jsonStr(order.tif)}`,
    `${jsonStr('stp_mode')}:${jsonStr(order.stp_mode)}`,
    `${jsonStr('reduce_only')}:${order.reduce_only ? 'true' : 'false'}`,
  ];
  if (order.cloid !== undefined) {
    validateCloid(order.cloid);
    parts.push(`${jsonStr('cloid')}:${jsonStr(order.cloid)}`);
  }
  if (order.builder !== undefined) {
    parts.push(`${jsonStr('builder')}:${buildBuilder(order.builder)}`);
  }
  if (order.position_side !== undefined) {
    parts.push(`${jsonStr('position_side')}:${jsonStr(order.position_side)}`);
  }
  if (order.trigger !== undefined) {
    parts.push(`${jsonStr('trigger')}:${buildTrigger(order.trigger)}`);
  }
  return `{${parts.join(',')}}`;
}

/// Build the inner `{...}` body of one cancel (each element of a batch_cancel).
/// `oid` required (a cloid-only cancel is rejected at lowering).
function buildCancelBody(cancel: NativeCancel): string {
  validateAddress(cancel.owner, 'owner');
  validateMarket(cancel.market);
  if (cancel.oid === undefined && cancel.cloid === undefined) {
    throw new RangeError('cancel requires an oid (server cancels by oid)');
  }
  const parts: string[] = [
    `${jsonStr('owner')}:${jsonStr(cancel.owner)}`,
    `${jsonStr('market')}:${cancel.market}`,
  ];
  if (cancel.oid !== undefined) {
    validateU64(cancel.oid, 'oid');
    parts.push(`${jsonStr('oid')}:${cancel.oid}`);
  }
  if (cancel.cloid !== undefined) {
    validateCloid(cancel.cloid);
    parts.push(`${jsonStr('cloid')}:${jsonStr(cancel.cloid)}`);
  }
  return `{${parts.join(',')}}`;
}

/// Build the inner `{...}` body of one modify (modify / batch_modify).
function buildModifyBody(m: Modify): string {
  validateMarket(m.market);
  validateU64(m.oid, 'oid');
  const parts: string[] = [
    `${jsonStr('market')}:${m.market}`,
    `${jsonStr('oid')}:${m.oid}`,
  ];
  if (m.new_px !== undefined) {
    parts.push(`${jsonStr('new_px')}:${toU64(m.new_px, 'new_px')}`);
  }
  if (m.new_size !== undefined) {
    parts.push(`${jsonStr('new_size')}:${toU64(m.new_size, 'new_size')}`);
  }
  return `{${parts.join(',')}}`;
}

/// Wrap an already-built params body into `{"type":<type>,"params":<body>}`.
function wrapParams(type: string, paramsJson: string): string {
  return `{${jsonStr('type')}:${jsonStr(type)},${jsonStr('params')}:${paramsJson}}`;
}

// ---- order management ----

/// `cancel_by_cloid` — cancel a resting order by its client order id.
export function buildNativeCancelByCloidAction(params: CancelByCloid): string {
  validateMarket(params.asset);
  validateCloid(params.cloid);
  return wrapParams(
    'cancel_by_cloid',
    `{${jsonStr('asset')}:${params.asset},${jsonStr('cloid')}:${jsonStr(params.cloid)}}`,
  );
}

/// `modify` — amend a resting order's price and/or size in place.
export function buildNativeModifyAction(params: Modify): string {
  return wrapParams('modify', buildModifyBody(params));
}

/// `batch_modify` — N modifies under one signature.
export function buildNativeBatchModifyAction(params: BatchModify): string {
  const arr = params.modifications.map(buildModifyBody).join(',');
  return wrapParams('batch_modify', `{${jsonStr('modifications')}:[${arr}]}`);
}

/// `batch_order` — N orders under one signature. When a params-level `owner` is
/// present the gateway reads ownership from it (operator / vault trading) and it
/// is bound into the typed digest; otherwise ownership defaults to the signing
/// wallet. The params-level `owner` is emitted first to mirror the Rust SDK's
/// `BatchOrder` wire field order (owner, orders, grouping).
export function buildNativeBatchOrderAction(params: BatchOrder): string {
  const grouping = params.grouping ?? 'na';
  if (grouping !== 'na' && grouping !== 'normalTpsl' && grouping !== 'positionTpsl') {
    throw new RangeError('grouping must be na | normalTpsl | positionTpsl');
  }
  const arr = params.orders.map(buildOrderBody).join(',');
  const parts: string[] = [];
  if (params.owner !== undefined) {
    validateAddress(params.owner, 'owner');
    parts.push(`${jsonStr('owner')}:${jsonStr(params.owner)}`);
  }
  parts.push(`${jsonStr('orders')}:[${arr}]`);
  parts.push(`${jsonStr('grouping')}:${jsonStr(grouping)}`);
  return wrapParams('batch_order', `{${parts.join(',')}}`);
}

/// `batch_cancel` — N cancels under one signature.
export function buildNativeBatchCancelAction(params: BatchCancel): string {
  const arr = params.cancels.map(buildCancelBody).join(',');
  return wrapParams('batch_cancel', `{${jsonStr('cancels')}:[${arr}]}`);
}

/// `schedule_cancel` — cancel-all of the sender's open orders at a future block.
export function buildNativeScheduleCancelAction(params: ScheduleCancel): string {
  validateU64(params.cancel_at_block, 'cancel_at_block');
  return wrapParams(
    'schedule_cancel',
    `{${jsonStr('cancel_at_block')}:${params.cancel_at_block}}`,
  );
}

/// `cancel_all_orders` — cancel all of the sender's open orders (optional asset).
export function buildNativeCancelAllOrdersAction(
  params: CancelAllOrders = {},
): string {
  const parts: string[] = [];
  if (params.asset !== undefined) {
    validateMarket(params.asset);
    parts.push(`${jsonStr('asset')}:${params.asset}`);
  }
  return wrapParams('cancel_all_orders', `{${parts.join(',')}}`);
}

// ---- TWAP ----

/// `twap_order` — submit a sliced (TWAP) order.
export function buildNativeTwapOrderAction(params: TwapOrder): string {
  validateMarket(params.market);
  validateU64(params.total_size, 'total_size');
  validateU32(params.slice_count, 'slice_count');
  validateU64(params.delay_ms, 'delay_ms');
  return wrapParams(
    'twap_order',
    `{${jsonStr('market')}:${params.market},${jsonStr('side')}:${jsonStr(params.side)},${jsonStr('total_size')}:${params.total_size},${jsonStr('slice_count')}:${params.slice_count},${jsonStr('delay_ms')}:${params.delay_ms},${jsonStr('reduce_only')}:${params.reduce_only ? 'true' : 'false'}}`,
  );
}

/// `twap_cancel` — cancel a running TWAP parent by id.
export function buildNativeTwapCancelAction(params: TwapCancel): string {
  validateU64(params.twap_id, 'twap_id');
  return wrapParams('twap_cancel', `{${jsonStr('twap_id')}:${params.twap_id}}`);
}

// ---- leverage & margin ----

/// `update_leverage` — set per-asset leverage (and optionally flip to isolated).
export function buildNativeUpdateLeverageAction(params: UpdateLeverage): string {
  validateMarket(params.asset);
  validateU32(params.leverage, 'leverage');
  return wrapParams(
    'update_leverage',
    `{${jsonStr('asset')}:${params.asset},${jsonStr('leverage')}:${params.leverage},${jsonStr('is_isolated')}:${params.is_isolated ? 'true' : 'false'}}`,
  );
}

/// `update_isolated_margin` — add (`+`) or remove (`-`) isolated margin.
export function buildNativeUpdateIsolatedMarginAction(
  params: UpdateIsolatedMargin,
): string {
  validateMarket(params.asset);
  validateDecimalString(params.delta, 'delta', { allowNegative: true });
  return wrapParams(
    'update_isolated_margin',
    `{${jsonStr('asset')}:${params.asset},${jsonStr('delta')}:${jsonStr(params.delta)}}`,
  );
}

/// `top_up_isolated_only_margin` — top up a strict-isolated-only position.
export function buildNativeTopUpIsolatedOnlyMarginAction(
  params: TopUpIsolatedOnlyMargin,
): string {
  validateMarket(params.asset);
  validateDecimalString(params.amount, 'amount');
  return wrapParams(
    'top_up_isolated_only_margin',
    `{${jsonStr('asset')}:${params.asset},${jsonStr('amount')}:${jsonStr(params.amount)}}`,
  );
}

/// `user_portfolio_margin` — enroll into or out of portfolio margin.
export function buildNativeUserPortfolioMarginAction(
  params: UserPortfolioMargin,
): string {
  return wrapParams(
    'user_portfolio_margin',
    `{${jsonStr('enroll')}:${params.enroll ? 'true' : 'false'}}`,
  );
}

// ---- account & agent settings ----

/// `set_display_name` — set the account display name (handle).
export function buildNativeSetDisplayNameAction(params: SetDisplayName): string {
  if (typeof params.display_name !== 'string' || params.display_name.length === 0) {
    throw new RangeError('display_name must be a non-empty string');
  }
  return wrapParams(
    'set_display_name',
    `{${jsonStr('display_name')}:${jsonStr(params.display_name)}}`,
  );
}

/// `set_referrer` — set the account referrer (one-time, immutable once set).
export function buildNativeSetReferrerAction(params: SetReferrer): string {
  validateAddress(params.referrer, 'referrer');
  return wrapParams(
    'set_referrer',
    `{${jsonStr('referrer')}:${jsonStr(params.referrer)}}`,
  );
}

/// `approve_agent` — approve an agent wallet to sign on this account's behalf.
export function buildNativeApproveAgentAction(params: ApproveAgent): string {
  validateAddress(params.agent, 'agent');
  const parts: string[] = [`${jsonStr('agent')}:${jsonStr(params.agent)}`];
  if (params.name !== undefined) {
    parts.push(`${jsonStr('name')}:${jsonStr(params.name)}`);
  }
  if (params.expires_at_ms !== undefined) {
    validateU64(params.expires_at_ms, 'expires_at_ms');
    parts.push(`${jsonStr('expires_at_ms')}:${params.expires_at_ms}`);
  }
  return wrapParams('approve_agent', `{${parts.join(',')}}`);
}

/// `approve_builder_fee` — approve a builder up to `max_bps` (`0` revokes).
export function buildNativeApproveBuilderFeeAction(
  params: ApproveBuilderFee,
): string {
  validateAddress(params.builder, 'builder');
  validateU16(params.max_bps, 'max_bps');
  return wrapParams(
    'approve_builder_fee',
    `{${jsonStr('builder')}:${jsonStr(params.builder)},${jsonStr('max_bps')}:${params.max_bps}}`,
  );
}

/// `convert_to_multi_sig_user` — convert the account to an M-of-N multisig.
export function buildNativeConvertToMultiSigUserAction(
  params: ConvertToMultiSigUser,
): string {
  const arr = params.signers
    .map((s, i) => {
      validateAddress(s, `signers[${i}]`);
      return jsonStr(s);
    })
    .join(',');
  validateU32(params.threshold, 'threshold');
  return wrapParams(
    'convert_to_multi_sig_user',
    `{${jsonStr('signers')}:[${arr}],${jsonStr('threshold')}:${params.threshold}}`,
  );
}

/// `user_dex_abstraction` — toggle the account's DEX-abstraction opt-in flag.
export function buildNativeUserDexAbstractionAction(
  params: UserDexAbstraction,
): string {
  return wrapParams(
    'user_dex_abstraction',
    `{${jsonStr('enabled')}:${params.enabled ? 'true' : 'false'}}`,
  );
}

/// `user_set_abstraction` — set a self-scoped abstraction config value.
export function buildNativeUserSetAbstractionAction(
  params: UserSetAbstraction,
): string {
  validateU8(params.kind, 'kind');
  validateDecimalString(params.value, 'value', {
    allowZero: true,
    allowNegative: true,
  });
  return wrapParams(
    'user_set_abstraction',
    `{${jsonStr('kind')}:${params.kind},${jsonStr('value')}:${jsonStr(params.value)}}`,
  );
}

/// `agent_set_abstraction` — an approved agent sets a config value for `user`.
export function buildNativeAgentSetAbstractionAction(
  params: AgentSetAbstraction,
): string {
  validateAddress(params.user, 'user');
  validateU8(params.kind, 'kind');
  validateDecimalString(params.value, 'value', {
    allowZero: true,
    allowNegative: true,
  });
  return wrapParams(
    'agent_set_abstraction',
    `{${jsonStr('user')}:${jsonStr(params.user)},${jsonStr('kind')}:${params.kind},${jsonStr('value')}:${jsonStr(params.value)}}`,
  );
}

/// `priority_bid` — pay a priority fee (bps) for block-front placement.
export function buildNativePriorityBidAction(params: PriorityBid): string {
  validateMarket(params.asset);
  validateU16(params.bid_bps, 'bid_bps');
  return wrapParams(
    'priority_bid',
    `{${jsonStr('asset')}:${params.asset},${jsonStr('bid_bps')}:${params.bid_bps}}`,
  );
}

// ---- staking ----

/// `token_delegate` — delegate stake to a validator, or queue an undelegation.
export function buildNativeTokenDelegateAction(params: TokenDelegate): string {
  validateAddress(params.validator, 'validator');
  validateDecimalString(params.amount, 'amount');
  return wrapParams(
    'token_delegate',
    `{${jsonStr('validator')}:${jsonStr(params.validator)},${jsonStr('amount')}:${jsonStr(params.amount)},${jsonStr('is_undelegate')}:${params.is_undelegate ? 'true' : 'false'}}`,
  );
}

/// `claim_rewards` — claim accrued staking rewards (optional validator filter).
export function buildNativeClaimRewardsAction(
  params: ClaimRewards = {},
): string {
  const parts: string[] = [];
  if (params.validator !== undefined) {
    validateAddress(params.validator, 'validator');
    parts.push(`${jsonStr('validator')}:${jsonStr(params.validator)}`);
  }
  return wrapParams('claim_rewards', `{${parts.join(',')}}`);
}

/// `link_staking_user` — alias another account as this account's staking target.
export function buildNativeLinkStakingUserAction(
  params: LinkStakingUser,
): string {
  validateAddress(params.target, 'target');
  return wrapParams(
    'link_staking_user',
    `{${jsonStr('target')}:${jsonStr(params.target)}}`,
  );
}

// ---- encrypted orders ----

/// `submit_encrypted_order` — submit a threshold-encrypted order ciphertext.
export function buildNativeSubmitEncryptedOrderAction(
  params: SubmitEncryptedOrder,
): string {
  if (!(params.ciphertext instanceof Uint8Array)) {
    throw new RangeError('ciphertext must be a Uint8Array');
  }
  if (!(params.commitment instanceof Uint8Array) || params.commitment.length !== 32) {
    throw new RangeError('commitment must be a 32-byte Uint8Array');
  }
  validateU8(params.threshold, 'threshold');
  validateU64(params.target_block, 'target_block');
  validateU64(params.reveal_deadline_ms, 'reveal_deadline_ms');
  const ct = `[${Array.from(params.ciphertext).join(',')}]`;
  const cm = `[${Array.from(params.commitment).join(',')}]`;
  return wrapParams(
    'submit_encrypted_order',
    `{${jsonStr('ciphertext')}:${ct},${jsonStr('commitment')}:${cm},${jsonStr('threshold')}:${params.threshold},${jsonStr('target_block')}:${params.target_block},${jsonStr('reveal_deadline_ms')}:${params.reveal_deadline_ms}}`,
  );
}

// ---- vaults ----

/// `create_vault` — create a new vault. The signing wallet becomes the leader.
export function buildNativeCreateVaultAction(params: CreateVault): string {
  if (typeof params.name !== 'string' || params.name.length === 0) {
    throw new RangeError('name must be a non-empty string');
  }
  validateU64(params.lock_period_secs, 'lock_period_secs');
  const kind = params.kind ?? 'User';
  if (kind !== 'User' && kind !== 'Metaliquidity') {
    throw new RangeError('kind must be User | Metaliquidity');
  }
  const parts: string[] = [
    `${jsonStr('name')}:${jsonStr(params.name)}`,
    `${jsonStr('lock_period_secs')}:${params.lock_period_secs}`,
  ];
  if (params.parent !== undefined) {
    validateU64(params.parent, 'parent');
    parts.push(`${jsonStr('parent')}:${params.parent}`);
  }
  parts.push(`${jsonStr('kind')}:${jsonStr(kind)}`);
  return wrapParams('create_vault', `{${parts.join(',')}}`);
}

/// `vault_transfer` — leader moves capital into / out of a vault.
export function buildNativeVaultTransferAction(params: VaultTransfer): string {
  validateU64(params.vault_id, 'vault_id');
  validateDecimalString(params.amount, 'amount');
  return wrapParams(
    'vault_transfer',
    `{${jsonStr('vault_id')}:${params.vault_id},${jsonStr('deposit')}:${params.deposit ? 'true' : 'false'},${jsonStr('amount')}:${jsonStr(params.amount)}}`,
  );
}

/// `vault_modify` — leader updates vault configuration (omitted = unchanged).
export function buildNativeVaultModifyAction(params: VaultModify): string {
  validateU64(params.vault_id, 'vault_id');
  const parts: string[] = [`${jsonStr('vault_id')}:${params.vault_id}`];
  if (params.new_name !== undefined) {
    parts.push(`${jsonStr('new_name')}:${jsonStr(params.new_name)}`);
  }
  if (params.new_lock_period_secs !== undefined) {
    validateU64(params.new_lock_period_secs, 'new_lock_period_secs');
    parts.push(`${jsonStr('new_lock_period_secs')}:${params.new_lock_period_secs}`);
  }
  if (params.new_management_fee_bps !== undefined) {
    validateU16(params.new_management_fee_bps, 'new_management_fee_bps');
    parts.push(`${jsonStr('new_management_fee_bps')}:${params.new_management_fee_bps}`);
  }
  if (params.new_paused !== undefined) {
    parts.push(`${jsonStr('new_paused')}:${params.new_paused ? 'true' : 'false'}`);
  }
  return wrapParams('vault_modify', `{${parts.join(',')}}`);
}

/// `vault_withdraw` — follower redeems shares (decimal string) from a vault.
export function buildNativeVaultWithdrawAction(params: VaultWithdraw): string {
  validateU64(params.vault_id, 'vault_id');
  validateDecimalString(params.shares, 'shares');
  return wrapParams(
    'vault_withdraw',
    `{${jsonStr('vault_id')}:${params.vault_id},${jsonStr('shares')}:${jsonStr(params.shares)}}`,
  );
}

/// `vault_distribute` — follower deposits USD into a vault, minting shares at
/// the current NAV. The deposit amount rides the **`pnl`** field (a legacy node
/// name) as a positive decimal string; `vault_id` is a bare number. Wrapper key
/// is `params`. Forward-compat: see the module note on the RFQ/FBA builders.
export function buildNativeVaultDistributeAction(params: VaultDistribute): string {
  validateU64(params.vault_id, 'vault_id');
  validateDecimalString(params.pnl, 'pnl');
  return wrapParams(
    'vault_distribute',
    `{${jsonStr('vault_id')}:${params.vault_id},${jsonStr('pnl')}:${jsonStr(params.pnl)}}`,
  );
}

// ---- MetaBridge ----

/// `mb_withdraw` — withdraw cross-collateral to a destination chain. `dst_addr`
/// is `0x` + 40 hex (EVM, Base/Arbitrum) or 64 hex (32-byte, Solana).
export function buildNativeMbWithdrawAction(params: MbWithdraw): string {
  if (params.chain !== 'Base' && params.chain !== 'Arbitrum' && params.chain !== 'Solana') {
    throw new RangeError('chain must be Base | Arbitrum | Solana');
  }
  validateU32(params.asset, 'asset');
  validateU64(params.amount, 'amount');
  const dstHex = params.dst_addr.startsWith('0x')
    ? params.dst_addr.slice(2)
    : params.dst_addr;
  if (!/^[0-9a-fA-F]+$/.test(dstHex) || (dstHex.length !== 40 && dstHex.length !== 64)) {
    throw new RangeError('dst_addr must be 0x + 40 (EVM) or 64 (Solana) hex chars');
  }
  return wrapParams(
    'mb_withdraw',
    `{${jsonStr('chain')}:${jsonStr(params.chain)},${jsonStr('asset')}:${params.asset},${jsonStr('amount')}:${params.amount},${jsonStr('dst_addr')}:${jsonStr(params.dst_addr)}}`,
  );
}

// ---- governance / operator ----

/// `set_metaliquidity_whitelist` — set an MLP whitelist membership (validator).
export function buildNativeSetMetaliquidityWhitelistAction(
  params: SetMetaliquidityWhitelist,
): string {
  validateAddress(params.address, 'address');
  return wrapParams(
    'set_metaliquidity_whitelist',
    `{${jsonStr('address')}:${jsonStr(params.address)},${jsonStr('allowed')}:${params.allowed ? 'true' : 'false'}}`,
  );
}

/// `register_metaliquidity_operator` — register / revoke a vault strategy operator.
export function buildNativeRegisterMetaliquidityOperatorAction(
  params: RegisterMetaliquidityOperator,
): string {
  validateU64(params.vault_id, 'vault_id');
  validateAddress(params.operator, 'operator');
  const parts: string[] = [
    `${jsonStr('vault_id')}:${params.vault_id}`,
    `${jsonStr('operator')}:${jsonStr(params.operator)}`,
    `${jsonStr('allowed')}:${params.allowed ? 'true' : 'false'}`,
  ];
  if (params.expires_at_ms !== undefined) {
    validateU64(params.expires_at_ms, 'expires_at_ms');
    parts.push(`${jsonStr('expires_at_ms')}:${params.expires_at_ms}`);
  }
  return wrapParams('register_metaliquidity_operator', `{${parts.join(',')}}`);
}

// ============================================================================
// Spot margin (leveraged spot) + Earn (lending pool) — devnet preview.
// All SENDER-AUTHORIZED (no owner field; the recovered signer is the actor).
// Decimal magnitudes (amount / borrow / shares) are emitted as JSON STRINGS;
// size / limit_px are bare integers on the raw-lot / 1e8 planes. Field order =
// the server struct declaration order.
// ============================================================================

/// Build the canonical native `spot_margin_deposit` action JSON string.
///
/// `{"type":"spot_margin_deposit","params":{"pair":<u32>,"amount":"<decimal>"}}`.
/// Posts quote collateral into the `(account, pair)` margin account (margin must
/// be enabled for the pair). SENDER-AUTHORIZED.
export function buildNativeSpotMarginDepositAction(
  params: NativeSpotMarginDeposit,
): string {
  validateMarket(params.pair);
  validateDecimalString(params.amount, 'amount');
  const paramsJson = `{${jsonStr('pair')}:${params.pair},${jsonStr('amount')}:${jsonStr(params.amount)}}`;
  return `{${jsonStr('type')}:${jsonStr('spot_margin_deposit')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `spot_margin_withdraw` action JSON string.
///
/// `{"type":"spot_margin_withdraw","params":{"pair":<u32>,"amount":"<decimal>"}}`.
/// Withdraws free collateral (initial-margin-gated while a position is open).
/// SENDER-AUTHORIZED.
export function buildNativeSpotMarginWithdrawAction(
  params: NativeSpotMarginWithdraw,
): string {
  validateMarket(params.pair);
  validateDecimalString(params.amount, 'amount');
  const paramsJson = `{${jsonStr('pair')}:${params.pair},${jsonStr('amount')}:${jsonStr(params.amount)}}`;
  return `{${jsonStr('type')}:${jsonStr('spot_margin_withdraw')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `spot_margin_open` action JSON string.
///
/// `{"type":"spot_margin_open","params":{"pair":<u32>,"size":<u64>,"limit_px":<u64>,"borrow":"<decimal>"}}`.
/// Borrows quote from the pair's Earn pool and IOC-buys `size` base on leverage;
/// gated by the initial-margin requirement on the worst-case cost. SENDER-AUTHORIZED.
export function buildNativeSpotMarginOpenAction(
  params: NativeSpotMarginOpen,
): string {
  validateMarket(params.pair);
  const sizeWire = toU64(params.size, 'size');
  const limitPxWire = toU64(params.limit_px, 'limit_px');
  if (sizeWire <= 0n) {
    throw new RangeError('spot_margin_open requires size > 0');
  }
  if (limitPxWire <= 0n) {
    throw new RangeError('spot_margin_open requires limit_px > 0');
  }
  validateDecimalString(params.borrow, 'borrow');
  const paramsJson = `{${jsonStr('pair')}:${params.pair},${jsonStr('size')}:${sizeWire},${jsonStr('limit_px')}:${limitPxWire},${jsonStr('borrow')}:${jsonStr(params.borrow)}}`;
  return `{${jsonStr('type')}:${jsonStr('spot_margin_open')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `spot_margin_close` action JSON string.
///
/// `{"type":"spot_margin_close","params":{"pair":<u32>,"limit_px":<u64>}}`.
/// IOC-sells the held base, repays principal + interest, returns the remainder
/// (a partial fill keeps the account open). SENDER-AUTHORIZED.
export function buildNativeSpotMarginCloseAction(
  params: NativeSpotMarginClose,
): string {
  validateMarket(params.pair);
  const limitPxWire = toU64(params.limit_px, 'limit_px');
  if (limitPxWire <= 0n) {
    throw new RangeError('spot_margin_close requires limit_px > 0');
  }
  const paramsJson = `{${jsonStr('pair')}:${params.pair},${jsonStr('limit_px')}:${limitPxWire}}`;
  return `{${jsonStr('type')}:${jsonStr('spot_margin_close')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `earn_deposit` action JSON string.
///
/// `{"type":"earn_deposit","params":{"asset":<u32>,"amount":"<decimal>"}}`.
/// Supplies quote into a lending pool for shares (1:1 on a fresh pool, else
/// priced off NAV; the pool auto-creates on first deposit). SENDER-AUTHORIZED.
export function buildNativeEarnDepositAction(params: NativeEarnDeposit): string {
  validateU32(params.asset, 'asset');
  validateDecimalString(params.amount, 'amount');
  const paramsJson = `{${jsonStr('asset')}:${params.asset},${jsonStr('amount')}:${jsonStr(params.amount)}}`;
  return `{${jsonStr('type')}:${jsonStr('earn_deposit')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `earn_withdraw` action JSON string.
///
/// `{"type":"earn_withdraw","params":{"asset":<u32>,"shares":"<decimal>"}}`.
/// Redeems pool shares back to quote, clamped to the pool's idle liquidity.
/// SENDER-AUTHORIZED.
export function buildNativeEarnWithdrawAction(
  params: NativeEarnWithdraw,
): string {
  validateU32(params.asset, 'asset');
  validateDecimalString(params.shares, 'shares');
  const paramsJson = `{${jsonStr('asset')}:${params.asset},${jsonStr('shares')}:${jsonStr(params.shares)}}`;
  return `{${jsonStr('type')}:${jsonStr('earn_withdraw')},${jsonStr('params')}:${paramsJson}}`;
}

// ============================================================================
// RFQ / FBA / cross-chain / encrypted (forward-compat).
//
// The node recognizes these action tags but currently lowers them to
// `UnsupportedAction` on the public `/exchange` path (the real handlers run on
// the EVM core-writer path). The SDK emits the byte-correct wire shape each core
// param struct expects, so these become live the moment the node bridges them —
// no SDK change required. Note the per-action wrapper keys differ:
// `rfq` / `accept` / `submit` / `msg` / `encrypted` (NOT `params`).
//
// Traps mirrored from the node's plain `#[derive(Serialize)]`:
//   - `side` is PascalCase (`"Bid"`/`"Ask"`), distinct from the snake_case
//     `"bid"`/`"ask"` the perp/spot order builders use.
//   - `size` is a `u128` and `limit_px`/`price` are `i128`, emitted as bare JSON
//     numbers (the size/px planes can exceed 2^53, so they ride as `bigint`).
//   - `limit_px` (RFQ) / `stp_group` (RFQ + FBA) carry no serde default on the
//     node, so the key MUST be present — emit `null` when absent, do NOT omit.
//   - byte arrays (`recipient`, `ciphertext`, `commitment`) are JSON arrays of
//     byte-numbers, NOT 0x-hex strings.
// ============================================================================

/// Render a PascalCase core side token (`"Bid"`/`"Ask"`), failing loud on any
/// other value (a snake_case `"bid"`/`"ask"` here would be silently rejected by
/// the core handler).
function coreSideToken(side: CoreSide, field: string): string {
  if (side !== 'Bid' && side !== 'Ask') {
    throw new RangeError(`${field} must be "Bid" or "Ask" (PascalCase CoreSide)`);
  }
  return jsonStr(side);
}

/// Serialize a byte buffer as a JSON array of unsigned byte-numbers, optionally
/// pinning an exact length.
function byteArrayJson(bytes: Uint8Array, field: string, len?: number): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new RangeError(`${field} must be a Uint8Array`);
  }
  if (len !== undefined && bytes.length !== len) {
    throw new RangeError(`${field} must be exactly ${len} bytes`);
  }
  return `[${Array.from(bytes).join(',')}]`;
}

/// `rfq_request` — taker opens an RFQ session. Wrapper key is **`rfq`**. `side`
/// is PascalCase; `limit_px` (`i128`) and `stp_group` (`u64`) keys are ALWAYS
/// present (`null` when absent — the node has no serde default).
export function buildNativeRfqRequestAction(params: RfqRequest): string {
  validateMarket(params.market);
  validateU128(params.size, 'size');
  validateU64(params.expiry_ms, 'expiry_ms');
  if (params.limit_px !== null) {
    validateI128(params.limit_px, 'limit_px');
  }
  if (params.stp_group !== null) {
    validateU64(params.stp_group, 'stp_group');
  }
  const limitPx = params.limit_px === null ? 'null' : params.limit_px.toString();
  const stpGroup = params.stp_group === null ? 'null' : `${params.stp_group}`;
  const rfqJson = `{${jsonStr('market')}:${params.market},${jsonStr('side')}:${coreSideToken(params.side, 'side')},${jsonStr('size')}:${params.size},${jsonStr('limit_px')}:${limitPx},${jsonStr('expiry_ms')}:${params.expiry_ms},${jsonStr('stp_group')}:${stpGroup}}`;
  return `{${jsonStr('type')}:${jsonStr('rfq_request')},${jsonStr('rfq')}:${rfqJson}}`;
}

/// `rfq_accept` — taker crosses against a specific resting quote. Wrapper key is
/// **`accept`** (NOT `rfq`).
export function buildNativeRfqAcceptAction(params: RfqAccept): string {
  validateU64(params.rfq_id, 'rfq_id');
  validateU32(params.quote_idx, 'quote_idx');
  validateU128(params.size, 'size');
  const acceptJson = `{${jsonStr('rfq_id')}:${params.rfq_id},${jsonStr('quote_idx')}:${params.quote_idx},${jsonStr('size')}:${params.size}}`;
  return `{${jsonStr('type')}:${jsonStr('rfq_accept')},${jsonStr('accept')}:${acceptJson}}`;
}

/// `fba_submit` — submit into a market's frequent-batch-auction pool. Wrapper
/// key is **`submit`**. The price field is **`price`** (NOT `limit_px`); `side`
/// is PascalCase; `stp_group` key is ALWAYS present (`null` when absent).
export function buildNativeFbaSubmitAction(params: FbaSubmit): string {
  validateMarket(params.market);
  validateU128(params.size, 'size');
  validateI128(params.price, 'price');
  if (params.stp_group !== null) {
    validateU64(params.stp_group, 'stp_group');
  }
  const stpGroup = params.stp_group === null ? 'null' : `${params.stp_group}`;
  const submitJson = `{${jsonStr('market')}:${params.market},${jsonStr('side')}:${coreSideToken(params.side, 'side')},${jsonStr('size')}:${params.size},${jsonStr('price')}:${params.price},${jsonStr('stp_group')}:${stpGroup}}`;
  return `{${jsonStr('type')}:${jsonStr('fba_submit')},${jsonStr('submit')}:${submitJson}}`;
}

/// `cross_chain_send` — initiate a chain-agnostic cross-chain transfer. Wrapper
/// key is **`msg`**. `recipient` is a 32-byte array; `amount` (`u128`) is a bare
/// JSON number (NOT hex).
export function buildNativeCrossChainSendAction(params: CrossChainSend): string {
  validateU32(params.dst_chain_id, 'dst_chain_id');
  const recipient = byteArrayJson(params.recipient, 'recipient', 32);
  validateU32(params.token, 'token');
  validateU128(params.amount, 'amount');
  validateU64(params.nonce, 'nonce');
  const msgJson = `{${jsonStr('dst_chain_id')}:${params.dst_chain_id},${jsonStr('recipient')}:${recipient},${jsonStr('token')}:${params.token},${jsonStr('amount')}:${params.amount},${jsonStr('nonce')}:${params.nonce}}`;
  return `{${jsonStr('type')}:${jsonStr('cross_chain_send')},${jsonStr('msg')}:${msgJson}}`;
}

/// `encrypted_order_submit` — submit a threshold-encrypted order. Wrapper key is
/// **`encrypted`**. Only 3 fields — DISTINCT from `submit_encrypted_order`
/// (5 fields, key `params`). `ciphertext`/`commitment` are byte arrays.
export function buildNativeEncryptedOrderSubmitAction(
  params: EncryptedOrderSubmit,
): string {
  const ct = byteArrayJson(params.ciphertext, 'ciphertext');
  const cm = byteArrayJson(params.commitment, 'commitment', 32);
  validateU64(params.reveal_deadline_ms, 'reveal_deadline_ms');
  const encJson = `{${jsonStr('ciphertext')}:${ct},${jsonStr('commitment')}:${cm},${jsonStr('reveal_deadline_ms')}:${params.reveal_deadline_ms}}`;
  return `{${jsonStr('type')}:${jsonStr('encrypted_order_submit')},${jsonStr('encrypted')}:${encJson}}`;
}
