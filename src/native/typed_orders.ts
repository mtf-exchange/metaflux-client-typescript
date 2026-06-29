// EIP-712 typed-action signing for the trading set (orders / cancels / TWAP /
// batches) — the structured wallet-signing path for the formerly-opaque actions.
//
// The wallet-signed account actions in `./typed.ts` are flat field lists, so a
// single `FieldSpec` model describes them. The trading actions are structurally
// richer: orders nest a builder carve + a trigger block (both flattened into the
// signed struct), sub-enums (side / kind / tif / stp / position_side / tpsl /
// grouping) are EIP-712 `string`s carried VERBATIM in their snake_case wire
// form, the cloid is a `0x`-hex string (`""` when absent), and the batch actions
// hash their item list as a `T[]` (`keccak256(concat(per-item words))`). This
// module mirrors that encoding field-for-field.
//
// Atomic encoding (CONSENSUS-FROZEN — identical to the account set):
//   hashStruct(s) = keccak256(typeHash || encodeData(s)), typeHash = keccak256(encodeType)
//   each field -> one 32-byte word, in declared order:
//     address  -> 20 bytes right-aligned (12 zero-byte left pad)
//     uintN    -> big-endian, zero-left-padded to 32
//     bool     -> uint8 0/1, zero-left-padded to 32
//     string   -> keccak256(utf8 bytes)            (sub-enums + cloid + chain)
//     T[]      -> keccak256(concat of element 32-byte words)   (batch items)
//   digest = keccak256(0x19 0x01 || domainSeparator || hashStruct)
//
// Optional fields flatten to sentinels (matching the server's wire->typed map):
//   - cloid absent      -> "" (empty string)
//   - no builder        -> fee 0 + zero address
//   - one-way account   -> position_side "" (no leg)
//   - no trigger block  -> trigger_px 0, trigger_is_market false, trigger_tpsl ""
//
// The 12 trading actions:
//   submit_order, cancel_order, spot_order, spot_cancel, cancel_by_cloid,
//   modify, batch_modify, schedule_cancel, twap_order, twap_cancel,
//   batch_order, batch_cancel.

import {
  be32,
  domainSeparator,
  jsonStr,
  toHex,
  hexToBytes,
  validateAddress,
  validateCloid,
  toU64,
  type U64Input,
  MTF_CHAIN_ID,
} from './digest.js';
import { metafluxChainTag, type TypedSignedAction } from './typed.js';
import {
  deriveAddressFromPubkey,
  keccak256,
  recoverPubkey,
  signSecp256k1,
} from '../wallet/wasm.js';
import type { MetafluxChainTag } from '../types/typed.js';
import type {
  BatchCancel,
  BatchModify,
  BatchOrder,
  CancelByCloid,
  Modify,
  NativeBuilder,
  NativeCancel,
  NativeOrder,
  NativeSpotCancel,
  NativeSpotOrder,
  ScheduleCancel,
  TwapCancel,
  TwapOrder,
} from '../types/index.js';

const enc = new TextEncoder();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ============================================================================
// encodeType strings (signing order = encodeType order = message field order).
//
// CONSENSUS-FROZEN: changing any string invalidates every client signature.
// These mirror the node's frozen trading-action EIP-712 type strings byte-for-byte.
// ============================================================================

const ENCODE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  submit_order:
    'MetaFluxTransaction:SubmitOrder(string metafluxChain,uint32 market,string side,string kind,uint64 size,uint64 limitPx,string tif,string stpMode,bool reduceOnly,string cloid,uint16 builderFee,address builderUser,string positionSide,uint64 triggerPx,bool triggerIsMarket,string triggerTpsl,uint64 nonce)',
  cancel_order:
    'MetaFluxTransaction:CancelOrder(string metafluxChain,uint32 market,uint64 oid,uint64 nonce)',
  spot_order:
    'MetaFluxTransaction:SpotOrder(string metafluxChain,uint32 pair,string side,uint64 size,uint64 limitPx,string tif,string stpMode,string cloid,uint64 nonce)',
  spot_cancel:
    'MetaFluxTransaction:SpotCancel(string metafluxChain,uint32 pair,uint64 oid,uint64 nonce)',
  cancel_by_cloid:
    'MetaFluxTransaction:CancelByCloid(string metafluxChain,uint32 asset,string cloid,uint64 nonce)',
  modify:
    'MetaFluxTransaction:Modify(string metafluxChain,uint32 market,uint64 oid,bool hasNewPx,uint64 newPx,bool hasNewSize,uint64 newSize,string cloid,bool alwaysPlace,uint64 nonce)',
  batch_modify:
    'MetaFluxTransaction:BatchModify(string metafluxChain,bytes32 modifications,uint64 nonce)',
  schedule_cancel:
    'MetaFluxTransaction:ScheduleCancel(string metafluxChain,uint64 cancelAtBlock,uint64 nonce)',
  twap_order:
    'MetaFluxTransaction:TwapOrder(string metafluxChain,uint32 market,string side,uint64 totalSize,uint32 sliceCount,uint64 delayMs,bool reduceOnly,uint64 nonce)',
  twap_cancel:
    'MetaFluxTransaction:TwapCancel(string metafluxChain,uint64 twapId,uint64 nonce)',
  batch_order:
    'MetaFluxTransaction:BatchOrder(string metafluxChain,bytes32 orders,string grouping,uint64 nonce)',
  batch_cancel:
    'MetaFluxTransaction:BatchCancel(string metafluxChain,bytes32 cancels,uint64 nonce)',
});

/// Owner-carrying encodeType strings — the agent-resolved params-level `owner`
/// (address) is inserted at position 2 (right after metafluxChain, before the
/// action's own fields), for operator / vault trading where the orders' owner
/// differs from the signer. Selected ONLY when an `owner` is bound; an owner-LESS
/// action uses the owner-less `ENCODE_TYPES` above so existing signatures still
/// verify (owner-absent digest byte-identical to today). These mirror the node's
/// `*_WITH_OWNER_TYPE` and the Rust SDK's `TY_*_WITH_OWNER` constants byte-for-byte.
///
/// `batch_order` carries its `owner` inside its own params struct (the
/// `BatchOrder.owner` field); the other seven take a digest-level `owner`
/// argument. Both land the `address owner` word at the same position 2.
const ENCODE_TYPES_WITH_OWNER: Readonly<Record<string, string>> = Object.freeze({
  spot_order:
    'MetaFluxTransaction:SpotOrder(string metafluxChain,address owner,uint32 pair,string side,uint64 size,uint64 limitPx,string tif,string stpMode,string cloid,uint64 nonce)',
  spot_cancel:
    'MetaFluxTransaction:SpotCancel(string metafluxChain,address owner,uint32 pair,uint64 oid,uint64 nonce)',
  cancel_by_cloid:
    'MetaFluxTransaction:CancelByCloid(string metafluxChain,address owner,uint32 asset,string cloid,uint64 nonce)',
  modify:
    'MetaFluxTransaction:Modify(string metafluxChain,address owner,uint32 market,uint64 oid,bool hasNewPx,uint64 newPx,bool hasNewSize,uint64 newSize,string cloid,bool alwaysPlace,uint64 nonce)',
  batch_modify:
    'MetaFluxTransaction:BatchModify(string metafluxChain,address owner,bytes32 modifications,uint64 nonce)',
  twap_cancel:
    'MetaFluxTransaction:TwapCancel(string metafluxChain,address owner,uint64 twapId,uint64 nonce)',
  batch_order:
    'MetaFluxTransaction:BatchOrder(string metafluxChain,address owner,bytes32 orders,string grouping,uint64 nonce)',
  batch_cancel:
    'MetaFluxTransaction:BatchCancel(string metafluxChain,address owner,bytes32 cancels,uint64 nonce)',
});

/// The trading actions that take a DIGEST-LEVEL agent-resolved `owner` (passed to
/// [`buildTypedOrder`] / [`signTypedOrder`]). `batch_order` is excluded — it
/// carries its owner inside its `BatchOrder.owner` params field — matching the
/// Rust SDK's `supports_owner` gating.
const OWNER_SUPPORTING_ACTIONS: ReadonlySet<string> = new Set([
  'spot_order',
  'spot_cancel',
  'cancel_by_cloid',
  'modify',
  'batch_modify',
  'twap_cancel',
  'batch_cancel',
]);

/// The set of snake_case `action.type` tags the trading-set typed scheme covers.
export const TYPED_ORDER_ACTION_TYPES: readonly string[] = Object.freeze(
  Object.keys(ENCODE_TYPES),
);

/// Whether the given snake_case action type is one of the 12 trading actions
/// signable under the typed scheme.
export function isTypedOrderAction(actionType: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENCODE_TYPES, actionType);
}

/// Whether `actionType` accepts a digest-level agent-resolved `owner` (the
/// `*_WITH_OWNER` shape), used for operator / vault trading. `batch_order` is
/// `false` here (its owner rides in `BatchOrder.owner`).
export function supportsOwner(actionType: string): boolean {
  return OWNER_SUPPORTING_ACTIONS.has(actionType);
}

/// Full encodeType string for a trading action. Pass `withOwner = true` to select
/// the owner-carrying variant (the params-level `owner` address word at position
/// 2) for an action that has one (`batch_order` + the seven owner-supporting
/// actions); other actions ignore it and return the owner-less variant.
export function encodeOrderType(actionType: string, withOwner = false): string {
  if (withOwner) {
    const owned = ENCODE_TYPES_WITH_OWNER[actionType];
    if (owned !== undefined) return owned;
  }
  const t = ENCODE_TYPES[actionType];
  if (t === undefined) {
    throw new RangeError(
      `'${actionType}' is not a trading typed action (covers: ${TYPED_ORDER_ACTION_TYPES.join(', ')})`,
    );
  }
  return t;
}

// ============================================================================
// Word encoders (the leaf 32-byte struct-hash words). The integer / address /
// bool / string primitives are the SAME as `./typed.ts`; restated locally as
// thin wrappers so this module's encoding is self-contained and auditable.
// ============================================================================

/// uintN big-endian, zero-left-padded to 32 bytes; range-checked to the width.
function encUint(value: bigint, bits: number, field: string): Uint8Array {
  if (value < 0n) throw new RangeError(`${field} must be non-negative`);
  if (value >= 1n << BigInt(bits)) {
    throw new RangeError(`${field} overflows uint${bits}`);
  }
  return be32(value);
}

/// Coerce a `u64` wire value (`number | bigint | string`) into a `bigint` for
/// word encoding — the SAME normalization the wire JSON uses, so the signed
/// digest and the POSTed bytes stay identical.
function asBigInt(value: U64Input, field: string): bigint {
  return toU64(value, field);
}

/// `address` -> 20 bytes right-aligned in a 32-byte word (12 zero-byte left pad).
function encAddr(addr: string, field: string): Uint8Array {
  validateAddress(addr, field);
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex), 12);
  return out;
}

/// `string` -> keccak256(utf8). Used for the chain tag, every sub-enum, and the
/// verbatim cloid `0x`-hex (or "" when absent).
async function encString(s: string): Promise<Uint8Array> {
  return keccak256(enc.encode(s));
}

/// `bool` -> uint8 0/1, zero-left-padded to 32.
function encBool(v: boolean): Uint8Array {
  return be32(v ? 1n : 0n);
}

/// Concatenate equal-length 32-byte words into one buffer.
function concatWords(words: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(words.length * 32);
  words.forEach((w, i) => out.set(w, i * 32));
  return out;
}

// ============================================================================
// Sub-enum -> canonical snake_case wire string. The typed digest hashes these
// as EIP-712 `string`s; the client signs the SAME canonical wire form the
// server re-derives from the parsed enum (1:1, the only accepted spelling).
// ============================================================================

const VALID_SIDE: ReadonlySet<string> = new Set(['bid', 'ask']);
const VALID_KIND: ReadonlySet<string> = new Set([
  'limit',
  'market',
  'stop_loss',
  'take_profit',
]);
const VALID_TIF: ReadonlySet<string> = new Set(['gtc', 'ioc', 'aon', 'alo']);
const VALID_STP: ReadonlySet<string> = new Set([
  'cancel_oldest',
  'cancel_newest',
  'cancel_both',
  'reject',
]);
const VALID_POSITION_SIDE: ReadonlySet<string> = new Set(['long', 'short']);
const VALID_TPSL: ReadonlySet<string> = new Set(['tp', 'sl']);
const VALID_GROUPING: ReadonlySet<string> = new Set([
  'na',
  'normalTpsl',
  'positionTpsl',
]);

function checkEnum(set: ReadonlySet<string>, v: string, field: string): string {
  if (!set.has(v)) {
    throw new RangeError(`${field} must be one of: ${[...set].join(', ')}`);
  }
  return v;
}

// ============================================================================
// Order / modify / cancel item words (the array elements + single payloads).
//
// A perp order -> 15 words; a modify -> 8 words; a cancel -> 2 words. These
// mirror the node's frozen per-item word layout exactly.
// ============================================================================

/// Flatten one wire perp order into its 15 signed struct-hash words. The `owner`
/// field on the wire order is NOT part of the typed digest (the server's typed
/// map omits it); only the named order fields are bound.
async function orderWords(o: NativeOrder): Promise<Uint8Array[]> {
  // Builder carve: absent -> fee 0 + zero address.
  let builderFee = 0;
  let builderUser = ZERO_ADDRESS;
  if (o.builder !== undefined) {
    builderFee = validateBuilderFee(o.builder);
    validateAddress(o.builder.user, 'builder.user');
    builderUser = o.builder.user;
  }
  // Trigger block: absent -> px 0, is_market false, tpsl "".
  let triggerPx = 0n;
  let triggerIsMarket = false;
  let triggerTpsl = '';
  if (o.trigger !== undefined) {
    triggerPx = asBigInt(o.trigger.trigger_px, 'trigger.trigger_px');
    triggerIsMarket = o.trigger.is_market;
    triggerTpsl = checkEnum(VALID_TPSL, o.trigger.tpsl, 'trigger.tpsl');
  }
  // cloid: verbatim 0x-hex, "" when absent.
  let cloid = '';
  if (o.cloid !== undefined) {
    validateCloid(o.cloid);
    cloid = o.cloid;
  }
  // position_side: "" when one-way (absent), else the leg string.
  const positionSide =
    o.position_side === undefined
      ? ''
      : checkEnum(VALID_POSITION_SIDE, o.position_side, 'position_side');

  return [
    encUint(asBigInt(o.market, 'market'), 32, 'market'),
    await encString(checkEnum(VALID_SIDE, o.side, 'side')),
    await encString(checkEnum(VALID_KIND, o.kind, 'kind')),
    encUint(asBigInt(o.size, 'size'), 64, 'size'),
    encUint(asBigInt(o.limit_px, 'limit_px'), 64, 'limit_px'),
    await encString(checkEnum(VALID_TIF, o.tif, 'tif')),
    await encString(checkEnum(VALID_STP, o.stp_mode, 'stp_mode')),
    encBool(o.reduce_only),
    await encString(cloid),
    encUint(BigInt(builderFee), 16, 'builder.fee'),
    encAddr(builderUser, 'builder.user'),
    await encString(positionSide),
    encUint(triggerPx, 64, 'trigger.trigger_px'),
    encBool(triggerIsMarket),
    await encString(triggerTpsl),
  ];
}

/// Validate a builder fee as a u16 and return it.
function validateBuilderFee(b: NativeBuilder): number {
  if (!Number.isInteger(b.fee) || b.fee < 0 || b.fee > 0xffff) {
    throw new RangeError('builder.fee must be a u16 (0..=65535)');
  }
  return b.fee;
}

/// Flatten one wire modify into its 8 signed struct-hash words. `new_px` /
/// `new_size` flatten to a presence bool + value (0 when absent); the SDK's
/// `Modify` type carries no `cloid` / `always_place`, so both default to the
/// server sentinels ("" / false) the typed map produces for an oid-addressed
/// modify.
async function modifyWords(m: Modify): Promise<Uint8Array[]> {
  const hasNewPx = m.new_px !== undefined;
  const hasNewSize = m.new_size !== undefined;
  return [
    encUint(asBigInt(m.market, 'market'), 32, 'market'),
    encUint(asBigInt(m.oid, 'oid'), 64, 'oid'),
    encBool(hasNewPx),
    encUint(hasNewPx ? asBigInt(m.new_px as number, 'new_px') : 0n, 64, 'new_px'),
    encBool(hasNewSize),
    encUint(
      hasNewSize ? asBigInt(m.new_size as number, 'new_size') : 0n,
      64,
      'new_size',
    ),
    await encString(''), // cloid sentinel: SDK modify addresses by oid.
    encBool(false), // always_place sentinel.
  ];
}

/// Flatten one wire cancel into its 2 `(market, oid)` words. A cancel with no
/// `oid` has no typed form (the typed digest binds `oid`) — fail loud so the
/// caller routes it via the legacy scheme rather than signing a wrong digest.
function cancelWords(c: NativeCancel): [Uint8Array, Uint8Array] {
  if (c.oid === undefined) {
    throw new RangeError(
      'a cloid-only cancel has no typed form (the typed digest binds oid)',
    );
  }
  return [
    encUint(asBigInt(c.market, 'market'), 32, 'market'),
    encUint(asBigInt(c.oid, 'oid'), 64, 'oid'),
  ];
}

/// `keccak256(concat(per-item words))` over a list of pre-encoded item words —
/// the `bytes32` aggregate field of a batch action. Item order is significant.
async function hashItems(items: Uint8Array[][]): Promise<Uint8Array> {
  const flat: Uint8Array[] = [];
  for (const words of items) flat.push(...words);
  return keccak256(concatWords(flat));
}

// ============================================================================
// encodeData builders -> the full ordered word list (chain word first, action
// fields, nonce word last) for each trading action.
// ============================================================================

async function encodeOrderData(
  actionType: string,
  payload: TypedOrderPayload,
  chainTag: MetafluxChainTag,
  nonce: bigint,
  owner?: string,
): Promise<Uint8Array[]> {
  const chainWord = await encString(chainTag);
  const nonceWord = encUint(nonce, 64, 'nonce');
  // Agent-resolved owner: bound right after metafluxChain for the seven
  // owner-supporting actions (operator / vault trading). `batch_order` carries
  // its owner inside its own struct, so it is NOT in this set (empty here).
  const ownerWords: Uint8Array[] =
    owner !== undefined && OWNER_SUPPORTING_ACTIONS.has(actionType)
      ? [encAddr(owner, 'owner')]
      : [];
  switch (actionType) {
    case 'submit_order': {
      const order = payload.order as NativeOrder;
      return [chainWord, ...(await orderWords(order)), nonceWord];
    }
    case 'cancel_order': {
      const c = payload.cancel as NativeCancel;
      const [marketWord, oidWord] = cancelWords(c);
      return [chainWord, marketWord, oidWord, nonceWord];
    }
    case 'spot_order': {
      const o = payload.order as NativeSpotOrder;
      const cloid = o.cloid === undefined ? '' : (validateCloid(o.cloid), o.cloid);
      return [
        chainWord,
        ...ownerWords,
        encUint(asBigInt(o.pair, 'pair'), 32, 'pair'),
        await encString(checkEnum(VALID_SIDE, o.side, 'side')),
        encUint(asBigInt(o.size, 'size'), 64, 'size'),
        encUint(asBigInt(o.limit_px, 'limit_px'), 64, 'limit_px'),
        await encString(checkEnum(VALID_TIF, o.tif ?? 'ioc', 'tif')),
        await encString(checkEnum(VALID_STP, o.stp_mode, 'stp_mode')),
        await encString(cloid),
        nonceWord,
      ];
    }
    case 'spot_cancel': {
      const c = payload.cancel as NativeSpotCancel;
      return [
        chainWord,
        ...ownerWords,
        encUint(asBigInt(c.pair, 'pair'), 32, 'pair'),
        encUint(asBigInt(c.oid, 'oid'), 64, 'oid'),
        nonceWord,
      ];
    }
    case 'cancel_by_cloid': {
      const p = payload.params as CancelByCloid;
      validateCloid(p.cloid);
      return [
        chainWord,
        ...ownerWords,
        encUint(asBigInt(p.asset, 'asset'), 32, 'asset'),
        await encString(p.cloid),
        nonceWord,
      ];
    }
    case 'modify': {
      const m = payload.params as Modify;
      return [chainWord, ...ownerWords, ...(await modifyWords(m)), nonceWord];
    }
    case 'batch_modify': {
      const p = payload.params as BatchModify;
      const items = await Promise.all(p.modifications.map(modifyWords));
      return [chainWord, ...ownerWords, await hashItems(items), nonceWord];
    }
    case 'schedule_cancel': {
      const p = payload.params as ScheduleCancel;
      return [
        chainWord,
        encUint(asBigInt(p.cancel_at_block, 'cancel_at_block'), 64, 'cancel_at_block'),
        nonceWord,
      ];
    }
    case 'twap_order': {
      const p = payload.params as TwapOrder;
      return [
        chainWord,
        encUint(asBigInt(p.market, 'market'), 32, 'market'),
        await encString(checkEnum(VALID_SIDE, p.side, 'side')),
        encUint(asBigInt(p.total_size, 'total_size'), 64, 'total_size'),
        encUint(asBigInt(p.slice_count, 'slice_count'), 32, 'slice_count'),
        encUint(asBigInt(p.delay_ms, 'delay_ms'), 64, 'delay_ms'),
        encBool(p.reduce_only),
        nonceWord,
      ];
    }
    case 'twap_cancel': {
      const p = payload.params as TwapCancel;
      return [
        chainWord,
        ...ownerWords,
        encUint(asBigInt(p.twap_id, 'twap_id'), 64, 'twap_id'),
        nonceWord,
      ];
    }
    case 'batch_order': {
      const p = payload.params as BatchOrder;
      const grouping = checkEnum(VALID_GROUPING, p.grouping ?? 'na', 'grouping');
      const items = await Promise.all(p.orders.map(orderWords));
      const ordersWord = await hashItems(items);
      const groupingWord = await encString(grouping);
      // Owner-carrying variant: insert the params-level `owner` address word at
      // position 2 (after metafluxChain, before the orders hash). Gated on
      // presence — an owner-less batch keeps the original owner-less layout so
      // existing signatures still verify. Matches the Rust SDK word order.
      if (p.owner !== undefined) {
        return [
          chainWord,
          encAddr(p.owner, 'owner'),
          ordersWord,
          groupingWord,
          nonceWord,
        ];
      }
      return [chainWord, ordersWord, groupingWord, nonceWord];
    }
    case 'batch_cancel': {
      const p = payload.params as BatchCancel;
      const items = p.cancels.map(cancelWords);
      return [chainWord, ...ownerWords, await hashItems(items), nonceWord];
    }
    default:
      throw new RangeError(`'${actionType}' is not a trading typed action`);
  }
}

// ============================================================================
// Canonical action JSON (the bytes POSTed under `action`). The trading actions
// wrap their payload under DIFFERENT keys than the account set: `order` /
// `cancel` for the single order/cancel paths, `params` for the rest. The JSON is
// hand-built so the POSTed bytes are caller-controlled (matching the legacy
// `./actions.js` builders), but for the typed scheme the digest covers the
// EIP-712 struct, not these bytes — so we reuse the canonical wire shape.
// ============================================================================

/// The payload union accepted by [`buildTypedOrder`]: the single-order/cancel
/// paths carry `order` / `cancel`; everything else carries `params`.
export interface TypedOrderPayload {
  /// The perp / spot order body (submit_order / spot_order).
  order?: NativeOrder | NativeSpotOrder;
  /// The cancel body (cancel_order / spot_cancel).
  cancel?: NativeCancel | NativeSpotCancel;
  /// The action params body (everything else).
  params?:
    | CancelByCloid
    | Modify
    | BatchModify
    | ScheduleCancel
    | TwapOrder
    | TwapCancel
    | BatchOrder
    | BatchCancel;
}

// ============================================================================
// Build / digest / sign / recover / POST body.
// ============================================================================

/// A built typed trading action: the ordered struct words + the canonical
/// `action` JSON to POST, plus the chain id + nonce bound into the digest. The
/// `action` JSON is produced by the caller (the `./actions.js` builders); the
/// digest is computed over the EIP-712 struct, independent of the JSON bytes.
export interface BuiltTypedOrder {
  readonly actionType: string;
  readonly chainId: number;
  readonly chainTag: MetafluxChainTag;
  readonly nonce: bigint;
  readonly actionJson: string;
  readonly words: readonly Uint8Array[];
  /// True for an owner-carrying digest — selects the owner variant of the
  /// encodeType string (matching the extra `owner` word in `words`). Set for an
  /// owner-carrying `batch_order` (its `BatchOrder.owner`) AND for any of the
  /// seven owner-supporting actions signed with a bound `owner`. False otherwise.
  readonly withOwner: boolean;
  /// The digest-level agent-resolved owner bound for the seven owner-supporting
  /// actions. `undefined` for an owner-less digest and for `batch_order` (whose
  /// owner rides in `BatchOrder.owner`, not this field).
  readonly owner?: string;
}

/// Build a typed trading action from its wire payload + the canonical action
/// JSON string (the same string POSTed verbatim). `payload` carries the order /
/// cancel / params body under its natural key; `nonce` and `chainId` bind the
/// envelope.
export async function buildTypedOrder(
  actionType: string,
  payload: TypedOrderPayload,
  actionJson: string,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
  owner?: string,
): Promise<BuiltTypedOrder> {
  if (!isTypedOrderAction(actionType)) {
    throw new RangeError(`'${actionType}' is not a trading typed action`);
  }
  if (nonce < 0n) throw new RangeError('nonce must be non-negative');
  if (nonce >= 1n << 64n) throw new RangeError('nonce overflows u64');
  const chainTag = metafluxChainTag(chainId);
  const words = await encodeOrderData(actionType, payload, chainTag, nonce, owner);
  // The digest-level `owner` binds only for the seven owner-supporting actions;
  // `batch_order` reports `withOwner` off its in-struct `BatchOrder.owner`.
  const ownerBound = owner !== undefined && OWNER_SUPPORTING_ACTIONS.has(actionType);
  const withOwner =
    ownerBound ||
    (actionType === 'batch_order' &&
      (payload.params as BatchOrder | undefined)?.owner !== undefined);
  return {
    actionType,
    chainId,
    chainTag,
    nonce,
    actionJson,
    words,
    withOwner,
    owner: ownerBound ? owner : undefined,
  };
}

/// `hashStruct(s) = keccak256(typeHash || encodeData)` for a built trading action.
async function hashStructOrder(built: BuiltTypedOrder): Promise<Uint8Array> {
  const typeHash = await keccak256(
    enc.encode(encodeOrderType(built.actionType, built.withOwner)),
  );
  return keccak256(concatWords([typeHash, ...built.words]));
}

/// Full EIP-712 digest for a typed trading action:
/// `keccak256(0x19 0x01 || domainSeparator || hashStruct)`.
export async function typedOrderDigest(built: BuiltTypedOrder): Promise<Uint8Array> {
  const domainSep = await domainSeparator(built.chainId);
  const structHash = await hashStructOrder(built);
  const envelope = new Uint8Array(2 + 32 + 32);
  envelope[0] = 0x19;
  envelope[1] = 0x01;
  envelope.set(domainSep, 2);
  envelope.set(structHash, 34);
  return keccak256(envelope);
}

/// Sign a typed trading action with a 32-byte private key (the local / agent /
/// test path). Builds the same 0x1901 digest a wallet's `eth_signTypedData_v4`
/// would, and returns the `{ actionJson, nonce, signature }` ready for
/// `POST /exchange` with `sig_scheme:"typed"`.
export async function signTypedOrder(
  privateKey: Uint8Array,
  actionType: string,
  payload: TypedOrderPayload,
  actionJson: string,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
  owner?: string,
): Promise<TypedSignedAction> {
  if (privateKey.length !== 32) throw new RangeError('privateKey must be exactly 32 bytes');
  const built = await buildTypedOrder(actionType, payload, actionJson, nonce, chainId, owner);
  const digest = await typedOrderDigest(built);
  const sig = await signSecp256k1(privateKey, digest);
  return { actionJson, nonce, signature: `0x${toHex(sig)}` };
}

/// Recover the 20-byte signer of a signed typed trading action — handy for a
/// pre-POST owner assertion. Rebuilds the digest from the wire payload.
export async function recoverTypedOrderSigner(
  signed: TypedSignedAction,
  actionType: string,
  payload: TypedOrderPayload,
  chainId: number = MTF_CHAIN_ID,
  owner?: string,
): Promise<string> {
  const built = await buildTypedOrder(
    actionType,
    payload,
    signed.actionJson,
    signed.nonce,
    chainId,
    owner,
  );
  const digest = await typedOrderDigest(built);
  const sigHex = signed.signature.startsWith('0x')
    ? signed.signature.slice(2)
    : signed.signature;
  const pubkey = await recoverPubkey(hexToBytes(sigHex), digest);
  const addr = await deriveAddressFromPubkey(pubkey);
  return `0x${toHex(addr)}`;
}

/// Assemble the `POST /exchange` request body STRING for the typed scheme:
/// `{"action":<actionJson>,"nonce":<u64>,"signature":"0x..","sig_scheme":"typed"}`.
/// Identical envelope to `./typed.ts::typedRequestBody`; restated here so the
/// trading-set path is self-contained.
export function typedOrderRequestBody(signed: TypedSignedAction): string {
  return (
    `{${jsonStr('action')}:${signed.actionJson},` +
    `${jsonStr('nonce')}:${signed.nonce},` +
    `${jsonStr('signature')}:${jsonStr(signed.signature)},` +
    `${jsonStr('sig_scheme')}:${jsonStr('typed')}}`
  );
}
