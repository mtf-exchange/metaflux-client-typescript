// MTF-native signed-action builders — hand-built canonical snake_case JSON.
//
// Each `build*Action(payload): string` produces the EXACT bytes that are BOTH
// signed (`signNativeAction`) and POSTed verbatim (`nativeRequestBody`). Field
// ORDER is load-bearing: it mirrors the server struct declaration order so the
// recovered-over-`RawValue` signature matches byte-for-byte. Never re-stringify
// a parsed object — the digest covers these exact bytes.
//
// The 5 original builders (submit_order / cancel_order / set_position_mode /
// spot_order / spot_cancel) are byte-pinned by `__tests__/native.test.ts`; the
// 11 new actions mirror the Rust client `rest/exchange.rs`.

import {
  jsonStr,
  validateAddress,
  validateCloid,
  validateMarket,
  validateU8,
  validateU16,
  validateU32,
  validateU64,
  validateU128,
} from './digest.js';
import type {
  CrossChainSend,
  EncryptedOrderSubmit,
  FbaSubmit,
  NativeBuilder,
  NativeCancel,
  NativeOrder,
  NativeSetPositionMode,
  NativeSpotCancel,
  NativeSpotOrder,
  PmEnroll,
  PmRebalance,
  PmUnenroll,
  RfqAccept,
  RfqRequest,
  VaultCreate,
  VaultDistribute,
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
    `${jsonStr('size')}:${order.size}`,
    `${jsonStr('limit_px')}:${order.limit_px}`,
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
  const orderJson = `{${parts.join(',')}}`;
  return `{${jsonStr('type')}:${jsonStr('submit_order')},${jsonStr('order')}:${orderJson}}`;
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
/// Field order mirrors the server `NativeCancel` exactly
/// (per the KB spec metaflux-knowledges/api/rest/exchange.md): `owner`, `market`,
/// then `oid` / `cloid` when present. The server's `CancelParams` bridge
/// cancels by `oid`, so an `oid` is REQUIRED for the cancel to lower
/// successfully (a `cloid`-only cancel is accepted on the wire but rejected at
/// lowering with `CancelMissingOid`); we still emit either form so the bytes
/// stay caller-controlled. The returned string is BOTH signed and sent.
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

/// Build the canonical native `spot_order` action JSON string (SE-0 spot CLOB).
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
  if (order.limit_px <= 0) {
    throw new RangeError('spot_order v0 requires limit_px > 0 (market px rejected)');
  }
  const parts: string[] = [
    `${jsonStr('pair')}:${order.pair}`,
    `${jsonStr('side')}:${jsonStr(order.side)}`,
    `${jsonStr('size')}:${order.size}`,
    `${jsonStr('limit_px')}:${order.limit_px}`,
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
// New native write actions (mirror the Rust client `rest/exchange.rs`).
// Each hand-builds its canonical snake_case JSON; field order = the Rust struct
// declaration order. OWNER-CHECKED actions carry an actor address the recovered
// signer must equal; SENDER-AUTHORIZED actions carry no such field.
// ============================================================================

/// Build the canonical native `vault_create` action JSON string.
///
/// `{"type":"vault_create","vault":{leader, seed_cents, management_fee_bps}}`.
/// OWNER-CHECKED: `leader` must equal the signing wallet.
export function buildNativeVaultCreateAction(vault: VaultCreate): string {
  validateAddress(vault.leader, 'leader');
  validateU64(vault.seed_cents, 'seed_cents');
  validateU16(vault.management_fee_bps, 'management_fee_bps');
  const vaultJson = `{${jsonStr('leader')}:${jsonStr(vault.leader)},${jsonStr('seed_cents')}:${vault.seed_cents},${jsonStr('management_fee_bps')}:${vault.management_fee_bps}}`;
  return `{${jsonStr('type')}:${jsonStr('vault_create')},${jsonStr('vault')}:${vaultJson}}`;
}

/// Build the canonical native `vault_distribute` action JSON string.
///
/// `{"type":"vault_distribute","params":{vault_id, amount_cents}}`.
/// SENDER-AUTHORIZED (no owner field).
export function buildNativeVaultDistributeAction(
  params: VaultDistribute,
): string {
  validateU64(params.vault_id, 'vault_id');
  validateU64(params.amount_cents, 'amount_cents');
  const paramsJson = `{${jsonStr('vault_id')}:${params.vault_id},${jsonStr('amount_cents')}:${params.amount_cents}}`;
  return `{${jsonStr('type')}:${jsonStr('vault_distribute')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `vault_withdraw` action JSON string.
///
/// `{"type":"vault_withdraw","params":{vault_id, shares}}`. `shares` is a u128
/// emitted as a bare unquoted integer (serde u128 JSON number form).
/// SENDER-AUTHORIZED (no owner field).
export function buildNativeVaultWithdrawAction(params: VaultWithdraw): string {
  validateU64(params.vault_id, 'vault_id');
  validateU128(params.shares, 'shares');
  const paramsJson = `{${jsonStr('vault_id')}:${params.vault_id},${jsonStr('shares')}:${params.shares.toString()}}`;
  return `{${jsonStr('type')}:${jsonStr('vault_withdraw')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `pm_enroll` action JSON string.
///
/// `{"type":"pm_enroll","params":{user}}`. OWNER-CHECKED: `user` must equal the
/// signing wallet. Opts the account into portfolio margin.
export function buildNativePmEnrollAction(params: PmEnroll): string {
  validateAddress(params.user, 'user');
  const paramsJson = `{${jsonStr('user')}:${jsonStr(params.user)}}`;
  return `{${jsonStr('type')}:${jsonStr('pm_enroll')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `pm_unenroll` action JSON string.
///
/// `{"type":"pm_unenroll","params":{user}}`. OWNER-CHECKED: `user` must equal
/// the signing wallet. Opts the account back out of portfolio margin.
export function buildNativePmUnenrollAction(params: PmUnenroll): string {
  validateAddress(params.user, 'user');
  const paramsJson = `{${jsonStr('user')}:${jsonStr(params.user)}}`;
  return `{${jsonStr('type')}:${jsonStr('pm_unenroll')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `pm_rebalance` action JSON string.
///
/// `{"type":"pm_rebalance","params":{user}}`. SENDER-AUTHORIZED. Triggers a
/// portfolio-margin rebalance for `user`.
export function buildNativePmRebalanceAction(params: PmRebalance): string {
  validateAddress(params.user, 'user');
  const paramsJson = `{${jsonStr('user')}:${jsonStr(params.user)}}`;
  return `{${jsonStr('type')}:${jsonStr('pm_rebalance')},${jsonStr('params')}:${paramsJson}}`;
}

/// Build the canonical native `rfq_request` action JSON string.
///
/// `{"type":"rfq_request","rfq":{taker, market, side, size, window_ms}}`.
/// OWNER-CHECKED: `taker` must equal the signing wallet.
export function buildNativeRfqRequestAction(rfq: RfqRequest): string {
  validateAddress(rfq.taker, 'taker');
  validateMarket(rfq.market);
  validateU64(rfq.size, 'size');
  validateU32(rfq.window_ms, 'window_ms');
  const rfqJson = `{${jsonStr('taker')}:${jsonStr(rfq.taker)},${jsonStr('market')}:${rfq.market},${jsonStr('side')}:${jsonStr(rfq.side)},${jsonStr('size')}:${rfq.size},${jsonStr('window_ms')}:${rfq.window_ms}}`;
  return `{${jsonStr('type')}:${jsonStr('rfq_request')},${jsonStr('rfq')}:${rfqJson}}`;
}

/// Build the canonical native `rfq_accept` action JSON string.
///
/// `{"type":"rfq_accept","accept":{rfq_id, mm, price}}`. SENDER-AUTHORIZED — the
/// market maker accepts an outstanding RFQ.
export function buildNativeRfqAcceptAction(accept: RfqAccept): string {
  validateU64(accept.rfq_id, 'rfq_id');
  validateAddress(accept.mm, 'mm');
  validateU64(accept.price, 'price');
  const acceptJson = `{${jsonStr('rfq_id')}:${accept.rfq_id},${jsonStr('mm')}:${jsonStr(accept.mm)},${jsonStr('price')}:${accept.price}}`;
  return `{${jsonStr('type')}:${jsonStr('rfq_accept')},${jsonStr('accept')}:${acceptJson}}`;
}

/// Build the canonical native `fba_submit` action JSON string.
///
/// `{"type":"fba_submit","submit":{owner, market, side, size, limit_px, batch_id}}`.
/// OWNER-CHECKED: `owner` must equal the signing wallet. Submits a frequent-
/// batch-auction order.
export function buildNativeFbaSubmitAction(submit: FbaSubmit): string {
  validateAddress(submit.owner, 'owner');
  validateMarket(submit.market);
  validateU64(submit.size, 'size');
  validateU64(submit.limit_px, 'limit_px');
  validateU64(submit.batch_id, 'batch_id');
  const submitJson = `{${jsonStr('owner')}:${jsonStr(submit.owner)},${jsonStr('market')}:${submit.market},${jsonStr('side')}:${jsonStr(submit.side)},${jsonStr('size')}:${submit.size},${jsonStr('limit_px')}:${submit.limit_px},${jsonStr('batch_id')}:${submit.batch_id}}`;
  return `{${jsonStr('type')}:${jsonStr('fba_submit')},${jsonStr('submit')}:${submitJson}}`;
}

/// Build the canonical native `cross_chain_send` action JSON string.
///
/// `{"type":"cross_chain_send","msg":{sender, dst_chain, dst_address, asset, amount, nonce}}`.
/// `amount` is a u128 emitted as a bare unquoted integer; `nonce` here is the
/// action's OWN field (distinct from the replay nonce). OWNER-CHECKED: `sender`
/// must equal the signing wallet.
export function buildNativeCrossChainSendAction(msg: CrossChainSend): string {
  validateAddress(msg.sender, 'sender');
  validateU32(msg.dst_chain, 'dst_chain');
  validateAddress(msg.dst_address, 'dst_address');
  if (typeof msg.asset !== 'string' || msg.asset.length < 1 || msg.asset.length > 12) {
    throw new RangeError('asset must be a string of length 1..=12');
  }
  validateU128(msg.amount, 'amount');
  validateU64(msg.nonce, 'nonce');
  const msgJson = `{${jsonStr('sender')}:${jsonStr(msg.sender)},${jsonStr('dst_chain')}:${msg.dst_chain},${jsonStr('dst_address')}:${jsonStr(msg.dst_address)},${jsonStr('asset')}:${jsonStr(msg.asset)},${jsonStr('amount')}:${msg.amount.toString()},${jsonStr('nonce')}:${msg.nonce}}`;
  return `{${jsonStr('type')}:${jsonStr('cross_chain_send')},${jsonStr('msg')}:${msgJson}}`;
}

/// Build the canonical native `encrypted_order_submit` action JSON string.
///
/// `{"type":"encrypted_order_submit","encrypted":{submitter, ciphertext, threshold, target_block}}`.
/// `ciphertext` is a `Vec<u8>` emitted as a JSON array of byte numbers (serde
/// Vec<u8> wire form). OWNER-CHECKED: `submitter` must equal the signing wallet.
export function buildNativeEncryptedOrderSubmitAction(
  encrypted: EncryptedOrderSubmit,
): string {
  validateAddress(encrypted.submitter, 'submitter');
  if (!(encrypted.ciphertext instanceof Uint8Array)) {
    throw new RangeError('ciphertext must be a Uint8Array');
  }
  validateU8(encrypted.threshold, 'threshold');
  validateU64(encrypted.target_block, 'target_block');
  const ciphertextJson = `[${Array.from(encrypted.ciphertext).join(',')}]`;
  const encryptedJson = `{${jsonStr('submitter')}:${jsonStr(encrypted.submitter)},${jsonStr('ciphertext')}:${ciphertextJson},${jsonStr('threshold')}:${encrypted.threshold},${jsonStr('target_block')}:${encrypted.target_block}}`;
  return `{${jsonStr('type')}:${jsonStr('encrypted_order_submit')},${jsonStr('encrypted')}:${encryptedJson}}`;
}
