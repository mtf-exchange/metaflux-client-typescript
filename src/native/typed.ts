// EIP-712 typed-action signing — the structured wallet-signing path.
//
// Unlike the opaque `MetaFluxAction(string action,uint64 nonce)` envelope (see
// `./digest.ts`), each action here is a proper EIP-712 typed struct. A wallet
// asked to `eth_signTypedData_v4` renders the named fields (chain, amounts,
// addresses) rather than one base64 blob, so the user sees what they sign.
//
// Atomic encoding (frozen):
//   hashStruct(s) = keccak256(typeHash || encodeData(s)), typeHash = keccak256(encodeType)
//   each field -> one 32-byte word, in declared order:
//     address  -> 20 bytes right-aligned (12 zero-byte left pad)
//     uintN    -> big-endian, zero-left-padded to 32
//     bool     -> uint8 0/1, zero-left-padded to 32
//     string   -> keccak256(utf8 bytes)
//     T[]      -> keccak256(concat of element 32-byte words)
//   digest = keccak256(0x19 0x01 || domainSeparator || hashStruct)
//
// DECIMAL fields are EIP-712 `string` carrying the canonical decimal text. The
// SAME string is hashed and POSTed in the `action` JSON — the verifier hashes
// the verbatim string, then parses it. One canonical form per value ("1.0" and
// "1.00" hash differently).
//
// Each action is described once in `TYPED_SPECS` (field list = encodeType order
// = message order). From that single source we derive the encodeType string,
// the `eth_signTypedData_v4` payload, the struct-hash words, and the snake_case
// wire `action` JSON — so the signed message and the sent action can never
// drift apart.

import { be32, jsonStr, toHex, hexToBytes, validateAddress } from './digest.js';
import { MTF_CHAIN_ID } from './digest.js';
import {
  deriveAddressFromPubkey,
  keccak256,
  recoverPubkey,
  signSecp256k1,
} from '../wallet/wasm.js';
import type { MetafluxChainTag } from '../types/typed.js';

const enc = new TextEncoder();

const EIP712_DOMAIN_TYPE =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

/// Map an MTF chain id to its `metafluxChain` tag (the first signed field of
/// every typed struct). Unknown ids fall back to `"Devnet"`, matching the node.
export function metafluxChainTag(chainId: number): MetafluxChainTag {
  switch (chainId) {
    case 8964:
      return 'Mainnet';
    case 114514:
      return 'Testnet';
    case 31337:
      return 'Devnet';
    default:
      return 'Devnet';
  }
}

// ============================================================================
// Field-spec model. Each field declares its EIP-712 solidity type, the wire
// key (snake_case) it serializes under, and (camelCase) the typed-data name.
// ============================================================================

/// Supported EIP-712 leaf solidity types for the typed actions.
///
/// `presence-bool` / `opt-uint32` / `opt-uint64` are the halves of an OPTIONAL
/// wire field that the server flattens into a presence `bool` + value pair (the
/// same `Option<T>` → `(hasX: bool, x)` rule the node's `to_typed` applies). Both
/// read the SAME snake_case wire key: the presence half signs `true`/`false`
/// for present/absent, the value half signs the value (or `0` when absent). The
/// POST `action.params` carries only the original optional key (present or
/// omitted), never the flattened pair — exactly like the server's native action.
/// (`opt-uint64` is the 64-bit value half, for the RFQ / FBA optional u64s.)
///
/// `side-u8` backs the RFQ / FBA `side`: the POST `params.side` carries the core
/// `Side` PascalCase NAME (`"Bid"`/`"Ask"`), the signed word + v4 message value
/// are the `uint8` code (Bid=0, Ask=1) — the same string-in / code-signed split
/// `chain-u8` / `vault-kind` use.
///
/// `const-false-bool` signs a constant `false` and is NEVER written to the POST
/// `action.params` — it backs the `pm_unenroll` alias, whose paramless wire maps
/// to the `UserPortfolioMargin{enroll:false}` typed digest.
///
/// `bytes` / `bytes32` back the encrypted-order ciphertext / commitment: a
/// `Uint8Array` POSTed as a JSON byte array. `bytes` hashes `keccak256(raw)`;
/// `bytes32` is the raw 32 bytes carried verbatim into one word.
///
/// `bytes-hex` / `bytes[]-hex` back the multi-sig wrapper's `inner_action_blob`
/// / `signatures`: the wire form is a `0x`-hex STRING (resp. an array of them),
/// the signed word is `keccak256(decoded bytes)` (resp. `keccak256(concat of
/// per-element keccak256)`), and the v4 message renders the hex string(s). This
/// differs from `bytes` (which POSTs a JSON byte array) — the multi-sig wrapper
/// carries hex strings on the wire.
///
/// `string-decimal[]` backs the spot-deployer `spot_seed_holders.amounts`: an
/// EIP-712 `string[]` of VERBATIM decimal strings. The signed word is
/// `keccak256(concat of per-element keccak256(utf8))` — the standard
/// array-of-dynamic rule, the same shape `bytes[]-hex` uses.
///
/// `borrow-kind` backs `borrow_lend.kind`: the POST `params.kind` carries the
/// PascalCase enum NAME, the signed word + v4 message value are the `uint8`
/// code — the same string-in / code-signed split `vault-kind` and `side-u8` use.
///
/// `sentinel-uint64` backs `register_metaliquidity_operator.expires_at_ms`: an
/// OPTIONAL u64 whose `0` is the never-set sentinel. Absent signs `0` and omits
/// the key from the POST params; an explicit `0` is REFUSED here, because the
/// node refuses that wire form too. The digest flattens absent and explicit-`0`
/// to the same `uint64 0`, so one signature would cover two wire forms that
/// commit different state — never-expires against expired-at-epoch. Unlike
/// `opt-uint64` this kind carries no paired presence bool: the node's typed
/// struct declares a plain `uint64`.
type FieldSolidityType =
  | 'string'
  | 'string-decimal'
  | 'string-decimal[]'
  | 'chain-u8'
  | 'address'
  | 'address[]'
  | 'borrow-kind'
  | 'bool'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'vault-kind'
  | 'side-u8'
  | 'presence-bool'
  | 'opt-uint32'
  | 'opt-uint64'
  | 'sentinel-uint64'
  | 'const-false-bool'
  | 'bytes'
  | 'bytes32'
  | 'bytes-hex'
  | 'bytes[]-hex';

/// MetaBridge destination-chain string names → the `uint8` code the typed
/// `bridge_withdraw.chain` field signs. The POST `params.chain` carries the STRING
/// name; the signed word carries this code (Base=1, Arbitrum=2).
const MB_CHAIN_CODES: Readonly<Record<string, number>> = Object.freeze({
  Base: 1,
  Arbitrum: 2,
});

/// `VaultKind` PascalCase name → the `uint8` code the typed `create_vault.kind`
/// field signs. The POST `params.kind` carries the STRING name (the node
/// deserializes it as a `VaultKind` enum); the signed word carries this code
/// (User=0, Metaliquidity=1), matching the node's `vault_kind_u8`.
const VAULT_KIND_CODES: Readonly<Record<string, number>> = Object.freeze({
  User: 0,
  Metaliquidity: 1,
});

/// Core `Side` PascalCase name → the `uint8` code the typed RFQ / FBA `side`
/// field signs. The POST `params.side` carries the STRING name (the node's
/// `core_state::Side` enum has NO `rename_all`, so it deserializes PascalCase);
/// the signed word + v4 message value carry this code (Bid=0, Ask=1). Distinct
/// from the perp/spot order `side`, which signs the snake_case `"bid"`/`"ask"`
/// string verbatim (see `./typed_orders.ts`).
const SIDE_CODES: Readonly<Record<string, number>> = Object.freeze({
  Bid: 0,
  Ask: 1,
});

/// `BorrowLendKind` PascalCase name → the `uint8` code the typed
/// `borrow_lend.kind` field signs. The POST `params.kind` carries the STRING
/// name (the node's `BorrowLendKind` enum has NO `rename_all`, so it
/// deserializes PascalCase); the signed word + v4 message value carry this code.
/// `UnLend` keeps its capital `L` — that spelling IS the wire value.
const BORROW_LEND_KIND_CODES: Readonly<Record<string, number>> = Object.freeze({
  Lend: 0,
  UnLend: 1,
  Borrow: 2,
  Repay: 3,
});

/// One field of a typed struct.
interface FieldSpec {
  /// EIP-712 / camelCase field name (also the `message` key, per v4).
  readonly name: string;
  /// Solidity type used in the encodeType string + word encoding.
  readonly ty: FieldSolidityType;
  /// snake_case key this field is read from in the action payload + POST `params`.
  readonly wireKey: string;
  /// Default value for an OPTIONAL `uintN` field when the wire key is absent
  /// (`undefined` / `null`). Mirrors the server's `#[serde(default)]` on that
  /// param — the value is still signed + written to the POST `params`, matching
  /// the node reconstructing the SAME digest from the defaulted param. Only
  /// consulted for the `uint8` / `uint16` / `uint32` / `uint64` types; a field
  /// without a default keeps its required-present validation.
  readonly defaultUint?: bigint;
}

/// A full typed-action spec.
interface TypedSpec {
  /// PascalCase action name (primary type = `MetaFluxTransaction:<pascal>`).
  readonly pascal: string;
  /// snake_case wire `type` tag.
  readonly wireType: string;
  /// Ordered action-specific fields. The leading `metafluxChain` and trailing
  /// `nonce` are appended automatically.
  readonly fields: readonly FieldSpec[];
  /// When `true` AND no field contributes a POST param (every field is signed
  /// but omitted), the action JSON is emitted WITHOUT a `params` object — i.e.
  /// `{"type":<wireType>}`. Backs the paramless `pm_unenroll` alias (its only
  /// field is a `const-false-bool` that signs `enroll=false` but is never on the
  /// wire), matching the node's bare `{"type":"pm_unenroll"}` envelope.
  readonly emitNoParams?: boolean;
  /// When `true`, the wrapper `nonce` is ALSO emitted inside the POST `params`
  /// object (as a bare u64), not only at the envelope top level. Backs
  /// `multi_sig`, whose node struct `NativeMultiSig` reads a REQUIRED
  /// `params.nonce` serde field (no `#[serde(default)]`) — omitting it makes the
  /// node reject the POST at ingress (`missing field \`nonce\``). The value is
  /// identical to the top-level envelope nonce and the last signed word, so the
  /// EIP-712 digest is unaffected.
  readonly emitNonceInParams?: boolean;
}

function f(
  name: string,
  ty: FieldSolidityType,
  wireKey: string,
  defaultUint?: bigint,
): FieldSpec {
  return { name, ty, wireKey, defaultUint };
}

// The reachable typed actions. Field order is CONSENSUS-FROZEN — it is both
// the encodeType order and the `eth_signTypedData_v4` message order.
const TYPED_SPECS: Record<string, TypedSpec> = {
  // ---- transfers (3) ----
  send_asset: {
    pascal: 'SendAsset',
    wireType: 'send_asset',
    fields: [
      f('sourceDex', 'uint32', 'source_dex'),
      f('destinationDex', 'uint32', 'destination_dex'),
      f('asset', 'uint32', 'asset'),
      f('destination', 'address', 'destination'),
      f('amount', 'string-decimal', 'amount'),
      f('toPerp', 'bool', 'to_perp'),
    ],
  },
  usd_class_transfer: {
    pascal: 'UsdClassTransfer',
    wireType: 'usd_class_transfer',
    fields: [f('ntl', 'string-decimal', 'ntl'), f('toPerp', 'bool', 'to_perp')],
  },
  withdraw: {
    pascal: 'Withdraw',
    wireType: 'withdraw',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('amount', 'string-decimal', 'amount'),
      f('destinationChainId', 'uint32', 'destination_chain_id'),
      f('useCctp', 'bool', 'use_cctp'),
    ],
  },
  // ---- account / staking / vault ----
  approve_agent: {
    pascal: 'ApproveAgent',
    wireType: 'approve_agent',
    fields: [
      f('agentAddress', 'address', 'agent'),
      f('agentName', 'string', 'name'),
      // `0` = never expires; a real ms-epoch expiry signs verbatim (consensus-frozen).
      f('expiresAtMs', 'uint64', 'expires_at_ms'),
    ],
  },
  set_referrer: {
    pascal: 'SetReferrer',
    wireType: 'set_referrer',
    fields: [f('referrer', 'address', 'referrer')],
  },
  /// A deliberate no-op (132). It carries no field of its own — the digest is
  /// the chain tag and the nonce — so signing one burns a nonce and nothing else.
  noop: {
    pascal: 'Noop',
    wireType: 'noop',
    fields: [],
  },
  // `pascal` stays `ApproveBuilderFee`: the EIP-712 type string is
  // consensus-frozen, so only the wire tag moves to the broker name.
  approve_broker_fee: {
    pascal: 'ApproveBuilderFee',
    wireType: 'approve_broker_fee',
    fields: [
      f('builder', 'address', 'builder'),
      f('maxFeeBps', 'uint16', 'max_bps'),
    ],
  },
  approve_builder_fee: {
    pascal: 'ApproveBuilderFee',
    wireType: 'approve_broker_fee',
    fields: [
      f('builder', 'address', 'builder'),
      f('maxFeeBps', 'uint16', 'max_bps'),
    ],
  },
  set_display_name: {
    pascal: 'SetDisplayName',
    wireType: 'set_display_name',
    fields: [f('displayName', 'string', 'display_name')],
  },
  set_position_mode: {
    pascal: 'SetPositionMode',
    wireType: 'set_position_mode',
    fields: [f('hedge', 'bool', 'hedge')],
  },
  user_portfolio_margin: {
    pascal: 'UserPortfolioMargin',
    wireType: 'user_portfolio_margin',
    fields: [f('enroll', 'bool', 'enroll')],
  },
  convert_to_multi_sig_user: {
    pascal: 'ConvertToMultiSigUser',
    wireType: 'convert_to_multi_sig_user',
    fields: [
      f('signers', 'address[]', 'signers'),
      f('threshold', 'uint32', 'threshold'),
    ],
  },
  // The multi-sig acting WRAPPER. Carries the acting account (`user`), the exact
  // canonical inner-action bytes (`inner_action_blob`, 0x-hex on the wire), the
  // collected roster signatures (`signatures`, an array of 0x-hex 65-byte sigs),
  // and the wrapper `nonce`. The wrapper may be POSTed by ANY account — its
  // authority is the recovered inner-signer set (see `./multisig.ts`), not the
  // signer of this outer envelope. `nonce` MUST equal the inner nonce the roster
  // signed (advanced against `user`'s window), so callers pin it explicitly
  // rather than allocating a fresh one. NOT owner-supporting.
  multi_sig: {
    pascal: 'MultiSig',
    wireType: 'multi_sig',
    fields: [
      f('user', 'address', 'user'),
      f('innerActionBlob', 'bytes-hex', 'inner_action_blob'),
      f('signatures', 'bytes[]-hex', 'signatures'),
    ],
    // `NativeMultiSig` deserializes a REQUIRED `params.nonce` (user_actions.rs);
    // emit the wrapper nonce inside params or the node rejects the POST at ingress.
    emitNonceInParams: true,
  },
  update_leverage: {
    pascal: 'UpdateLeverage',
    wireType: 'update_leverage',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('leverage', 'uint32', 'leverage'),
      f('isIsolated', 'bool', 'is_isolated'),
    ],
  },
  claim_rewards: {
    pascal: 'ClaimRewards',
    wireType: 'claim_rewards',
    fields: [f('validator', 'address', 'validator')],
  },
  claim_referral_rewards: {
    pascal: 'ClaimReferralRewards',
    wireType: 'claim_referral_rewards',
    fields: [],
  },
  claim_builder_rewards: {
    pascal: 'ClaimBuilderRewards',
    wireType: 'claim_builder_rewards',
    fields: [],
  },
  vault_distribute: {
    pascal: 'VaultDistribute',
    wireType: 'vault_distribute',
    fields: [f('vaultId', 'uint64', 'vault_id'), f('pnl', 'string-decimal', 'pnl')],
  },
  link_staking_user: {
    pascal: 'LinkStakingUser',
    wireType: 'link_staking_user',
    fields: [f('target', 'address', 'target')],
  },
  create_vault: {
    pascal: 'CreateVault',
    wireType: 'create_vault',
    fields: [
      f('name', 'string', 'name'),
      f('lockPeriodSecs', 'uint64', 'lock_period_secs'),
      f('kind', 'vault-kind', 'kind'),
    ],
  },
  vault_modify: {
    pascal: 'VaultModify',
    wireType: 'vault_modify',
    fields: [
      f('vaultId', 'uint64', 'vault_id'),
      f('newName', 'string', 'new_name'),
    ],
  },
  spot_margin_close: {
    pascal: 'SpotMarginClose',
    wireType: 'spot_margin_close',
    fields: [f('pair', 'uint32', 'pair'), f('limitPx', 'uint64', 'limit_px')],
  },
  // ---- margin (2) ----
  update_isolated_margin: {
    pascal: 'UpdateIsolatedMargin',
    wireType: 'update_isolated_margin',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('delta', 'string-decimal', 'delta'),
    ],
  },
  top_up_isolated_only_margin: {
    pascal: 'TopUpIsolatedOnlyMargin',
    wireType: 'top_up_isolated_only_margin',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  // ---- staking (1) ----
  token_delegate: {
    pascal: 'TokenDelegate',
    wireType: 'token_delegate',
    fields: [
      f('validator', 'address', 'validator'),
      f('amount', 'string-decimal', 'amount'),
      f('isUndelegate', 'bool', 'is_undelegate'),
      // Lock tier in months (`0` flexible / `1` / `6` / `24`). The server ALWAYS
      // includes `lockMonths` in the type-hash + encoded struct (default 0);
      // signed so a relay cannot alter the delegation's lock tier / reward weight.
      f('lockMonths', 'uint8', 'lock_months', 0n),
    ],
  },
  // ---- agent settings (1) ----
  agent_set_abstraction: {
    pascal: 'AgentSetAbstraction',
    wireType: 'agent_set_abstraction',
    fields: [
      f('user', 'address', 'user'),
      f('kind', 'uint8', 'kind'),
      f('value', 'string', 'value'),
    ],
  },
  // ---- vaults (2) ----
  vault_transfer: {
    pascal: 'VaultTransfer',
    wireType: 'vault_transfer',
    fields: [
      f('vaultId', 'uint64', 'vault_id'),
      f('deposit', 'bool', 'deposit'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  vault_withdraw: {
    pascal: 'VaultWithdraw',
    wireType: 'vault_withdraw',
    fields: [
      f('vaultId', 'uint64', 'vault_id'),
      f('shares', 'string-decimal', 'shares'),
    ],
  },
  // ---- MetaBridge (1) ----
  bridge_withdraw: {
    pascal: 'BridgeWithdraw',
    wireType: 'bridge_withdraw',
    // `chain` rides POST `params` as the STRING name but signs as a uint8 code.
    // `amount` is an integer (uint64), not a decimal string.
    fields: [
      f('chain', 'chain-u8', 'chain'),
      f('asset', 'uint32', 'asset'),
      f('amount', 'uint64', 'amount'),
      f('dstAddr', 'string', 'dst_addr'),
    ],
  },
  // ---- spot margin (3) ----
  // DEAD SURFACE: the node rejects `spot_margin_deposit` / `spot_margin_withdraw`
  // while cross-margin is active (live: from genesis). Their type strings stay so
  // an old signature can still be reconstructed and verified.
  spot_margin_deposit: {
    pascal: 'SpotMarginDeposit',
    wireType: 'spot_margin_deposit',
    fields: [
      f('pair', 'uint32', 'pair'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  spot_margin_withdraw: {
    pascal: 'SpotMarginWithdraw',
    wireType: 'spot_margin_withdraw',
    fields: [
      f('pair', 'uint32', 'pair'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  spot_margin_open: {
    pascal: 'SpotMarginOpen',
    wireType: 'spot_margin_open',
    fields: [
      f('pair', 'uint32', 'pair'),
      f('size', 'uint64', 'size'),
      f('limitPx', 'uint64', 'limit_px'),
      f('borrow', 'string-decimal', 'borrow'),
    ],
  },
  // ---- earn (2) ----
  earn_deposit: {
    pascal: 'EarnDeposit',
    wireType: 'earn_deposit',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  earn_withdraw: {
    pascal: 'EarnWithdraw',
    wireType: 'earn_withdraw',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('shares', 'string-decimal', 'shares'),
    ],
  },
  // ---- BOLE lend / borrow (1) ----
  borrow_lend: {
    pascal: 'BorrowLend',
    wireType: 'borrow_lend',
    fields: [
      f('kind', 'borrow-kind', 'kind'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  // ---- metaliquidity vault leader (1) ----
  register_metaliquidity_operator: {
    pascal: 'RegisterMetaliquidityOperator',
    wireType: 'register_metaliquidity_operator',
    fields: [
      f('vaultId', 'uint64', 'vault_id'),
      f('operator', 'address', 'operator'),
      f('allowed', 'bool', 'allowed'),
      f('expiresAtMs', 'sentinel-uint64', 'expires_at_ms'),
    ],
  },
  // ---- SD-1 permissionless spot deployer lane (6) ----
  //
  // Sender-authorized: the recovered signer IS the deployer, so none of these
  // takes an `owner`. `max_deploy_fee` / `max_supply` / `amounts` are VERBATIM
  // decimal strings — the node hashes the exact text it received, then parses
  // it, so "1.0" and "1.00" are two different digests.
  //
  // `holders` / `amounts` are WHOLE UNITS, never wei. The spot ledger is a
  // whole-unit decimal; wei amounts mint 10^18 times too much AND the
  // `max_supply` checksum agrees, so the error is silent.
  spot_register_token: {
    pascal: 'SpotRegisterToken',
    wireType: 'spot_register_token',
    fields: [
      f('symbol', 'string', 'symbol'),
      f('szDecimals', 'uint8', 'sz_decimals'),
      f('weiDecimals', 'uint8', 'wei_decimals'),
      f('maxDeployFee', 'string-decimal', 'max_deploy_fee'),
    ],
  },
  spot_register_pair: {
    pascal: 'SpotRegisterPair',
    wireType: 'spot_register_pair',
    fields: [
      f('base', 'uint32', 'base'),
      f('quote', 'uint32', 'quote'),
      f('name', 'string', 'name'),
      f('maxDeployFee', 'string-decimal', 'max_deploy_fee'),
    ],
  },
  spot_set_pair_params: {
    pascal: 'SpotSetPairParams',
    wireType: 'spot_set_pair_params',
    fields: [
      f('pair', 'uint32', 'pair'),
      f('takerFeeDbps', 'uint32', 'taker_fee_dbps'),
      f('makerFeeDbps', 'uint32', 'maker_fee_dbps'),
      f('minNotionalCents', 'uint64', 'min_notional_cents'),
    ],
  },
  spot_set_pair_active: {
    pascal: 'SpotSetPairActive',
    wireType: 'spot_set_pair_active',
    fields: [f('pair', 'uint32', 'pair'), f('active', 'bool', 'active')],
  },
  spot_seed_holders: {
    pascal: 'SpotSeedHolders',
    wireType: 'spot_seed_holders',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('holders', 'address[]', 'holders'),
      f('amounts', 'string-decimal[]', 'amounts'),
    ],
  },
  spot_finalize_supply: {
    pascal: 'SpotFinalizeSupply',
    wireType: 'spot_finalize_supply',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('maxSupply', 'string-decimal', 'max_supply'),
    ],
  },
  // ---- MIP-3 permissionless perp deployer lane (9) ----
  //
  // One spec per `PerpDeployKind`. Each binds ONLY the fields its own
  // sub-handler reads, so no digest carries a field the chain ignores.
  // Sender-authorized: the recovered signer IS the deployer, so none takes an
  // `owner`. None carries `bid` — the legacy gas-auction lane is dead and the
  // handler rejects a non-zero bid.
  //
  // `perp_set_fee_tier` states the three legs SEPARATELY; the node packs them
  // into the one encoded value its handler decodes. The signer signs the legs
  // it means, not the packing.
  perp_register_asset: {
    pascal: 'PerpRegisterAsset',
    wireType: 'perp_register_asset',
    fields: [
      f('symbol', 'string', 'symbol'),
      f('decimals', 'uint8', 'decimals'),
      f('name', 'string', 'name'),
    ],
  },
  perp_set_oracle: {
    pascal: 'PerpSetOracle',
    wireType: 'perp_set_oracle',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('oracleSourceMask', 'uint16', 'oracle_source_mask'),
    ],
  },
  perp_set_leverage: {
    pascal: 'PerpSetLeverage',
    wireType: 'perp_set_leverage',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('maxLeverage', 'uint8', 'max_leverage'),
    ],
  },
  perp_set_fee_tier: {
    pascal: 'PerpSetFeeTier',
    wireType: 'perp_set_fee_tier',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('takerFeeDbps', 'uint32', 'taker_fee_dbps'),
      f('makerFeeDbps', 'uint32', 'maker_fee_dbps'),
      f('deployerFeeBps', 'uint32', 'deployer_fee_bps'),
    ],
  },
  perp_set_maker_rebate: {
    pascal: 'PerpSetMakerRebate',
    wireType: 'perp_set_maker_rebate',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('rebateBps', 'uint16', 'rebate_bps'),
    ],
  },
  perp_set_min_size: {
    pascal: 'PerpSetMinSize',
    wireType: 'perp_set_min_size',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('minOrderSize', 'uint64', 'min_order_size'),
    ],
  },
  perp_activate_market: {
    pascal: 'PerpActivateMarket',
    wireType: 'perp_activate_market',
    fields: [f('asset', 'uint32', 'asset')],
  },
  perp_deactivate_market: {
    pascal: 'PerpDeactivateMarket',
    wireType: 'perp_deactivate_market',
    fields: [f('asset', 'uint32', 'asset')],
  },
  perp_set_sub_deployers: {
    pascal: 'PerpSetSubDeployers',
    wireType: 'perp_set_sub_deployers',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('subDeployer', 'address', 'sub_deployer'),
      f('add', 'bool', 'add'),
    ],
  },
  // ---- MIP-3 deployer oracle (1) ----
  //
  // The tenth deployer action and the only repeating one. `asset` and the
  // VERBATIM `px` string are both in the digest, so a relay can neither reprice
  // a push nor re-target it at another market. It rides its own fork feature,
  // active from genesis on a fresh chain.
  mip3_set_oracle_px: {
    pascal: 'Mip3SetOraclePx',
    wireType: 'mip3_set_oracle_px',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('px', 'string-decimal', 'px'),
    ],
  },
  // ---- Core ↔ MetaFluxEVM transfer (1) ----
  core_evm_transfer: {
    pascal: 'CoreEvmTransfer',
    wireType: 'core_evm_transfer',
    fields: [
      f('amount', 'string-decimal', 'amount'),
      f('toEvm', 'bool', 'to_evm'),
      f('destination', 'address', 'destination'),
      f('asset', 'uint32', 'asset'),
    ],
  },
  // The payload-carrying form of the SAME wire action. It is never named by a
  // caller: `resolveTypedKey` picks it when the params carry `data` or
  // `destination_chain_id`. Both entries send `core_evm_transfer` on the wire.
  core_evm_transfer_v2: {
    pascal: 'CoreEvmTransferV2',
    wireType: 'core_evm_transfer',
    fields: [
      f('amount', 'string-decimal', 'amount'),
      f('toEvm', 'bool', 'to_evm'),
      f('destination', 'address', 'destination'),
      f('asset', 'uint32', 'asset'),
      f('destinationChainId', 'uint32', 'destination_chain_id'),
      f('data', 'bytes', 'data'),
    ],
  },
  // The payload-carrying transfer with the three extra HL-parity slots. It signs
  // TWO nonces: `transferNonce` reads the params key `nonce` (the caller's
  // transfer tag), and the trailing `nonce` word is the envelope nonce. The node
  // struct gives no serde default to any key, so every field must reach the POST
  // params — hence no optional halves here.
  send_to_evm_with_data: {
    pascal: 'SendToEvmWithData',
    wireType: 'send_to_evm_with_data',
    fields: [
      f('token', 'uint32', 'token'),
      f('amount', 'string-decimal', 'amount'),
      f('sourceDex', 'uint32', 'source_dex'),
      f('destinationRecipient', 'address', 'destination_recipient'),
      f('toPerp', 'bool', 'to_perp'),
      f('destinationChainId', 'uint32', 'destination_chain_id'),
      f('data', 'bytes', 'data'),
      f('transferNonce', 'uint64', 'nonce'),
    ],
  },
  // ---- account / sub-account / staking / abstraction / priority / encrypted ----
  // (formerly un-mapped on the typed-only `/exchange` — now reachable.)
  //
  // `create_sub_account` + `cancel_all_orders` carry an OPTIONAL wire field that
  // the server flattens to a presence `bool` + value pair (presence-bool +
  // opt-uint32, both reading the same wire key). `submit_encrypted_order` signs
  // `bytes` ciphertext + a `bytes32` commitment.
  create_sub_account: {
    pascal: 'CreateSubAccount',
    wireType: 'create_sub_account',
    fields: [
      f('name', 'string', 'name'),
      f('hasExplicitIndex', 'presence-bool', 'explicit_index'),
      f('explicitIndex', 'opt-uint32', 'explicit_index'),
      f('sharedStpGroup', 'bool', 'shared_stp_group'),
    ],
  },
  sub_account_transfer: {
    pascal: 'SubAccountTransfer',
    wireType: 'sub_account_transfer',
    fields: [
      f('subIndex', 'uint32', 'sub_index'),
      f('deposit', 'bool', 'deposit'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  sub_account_spot_transfer: {
    pascal: 'SubAccountSpotTransfer',
    wireType: 'sub_account_spot_transfer',
    fields: [
      f('subIndex', 'uint32', 'sub_index'),
      f('token', 'uint32', 'token'),
      f('deposit', 'bool', 'deposit'),
      f('amount', 'string-decimal', 'amount'),
    ],
  },
  c_deposit: {
    pascal: 'CDeposit',
    wireType: 'c_deposit',
    fields: [f('amount', 'string-decimal', 'amount')],
  },
  c_withdraw: {
    pascal: 'CWithdraw',
    wireType: 'c_withdraw',
    fields: [f('amount', 'string-decimal', 'amount')],
  },
  user_set_abstraction: {
    pascal: 'UserSetAbstraction',
    wireType: 'user_set_abstraction',
    fields: [
      f('kind', 'uint8', 'kind'),
      f('value', 'string-decimal', 'value'),
    ],
  },
  priority_bid: {
    pascal: 'PriorityBid',
    wireType: 'priority_bid',
    fields: [
      f('asset', 'uint32', 'asset'),
      f('bidBps', 'uint16', 'bid_bps'),
    ],
  },
  cancel_all_orders: {
    pascal: 'CancelAllOrders',
    wireType: 'cancel_all_orders',
    fields: [
      f('hasAsset', 'presence-bool', 'asset'),
      f('asset', 'opt-uint32', 'asset'),
    ],
  },
  submit_encrypted_order: {
    pascal: 'SubmitEncryptedOrder',
    wireType: 'submit_encrypted_order',
    fields: [
      f('ciphertext', 'bytes', 'ciphertext'),
      f('commitment', 'bytes32', 'commitment'),
      f('threshold', 'uint8', 'threshold'),
      f('targetBlock', 'uint64', 'target_block'),
      f('revealDeadlineMs', 'uint64', 'reveal_deadline_ms'),
    ],
  },
  // ---- RFQ / FBA microstructure (3) + 2 aliases ----
  //
  // `side` is the core `Side` PascalCase string on the wire, signed as a
  // `uint8` code (Bid=0/Ask=1); the numeric fields are RAW u64 wire values
  // (fixed-point lots/price), NOT decimal-scaled. `limit_px` / `stp_group` are
  // `Option<u64>` flattened to a presence bool + a u64 value (`0` when absent),
  // the key emitted on the wire ONLY when present.
  //
  // All three RFQ actions are owner-supporting; `fba_submit` is
  // sender-authorized (the recovered signer is the actor).
  rfq_request: {
    pascal: 'RfqRequest',
    wireType: 'rfq_request',
    fields: [
      f('market', 'uint32', 'market'),
      f('side', 'side-u8', 'side'),
      f('size', 'uint64', 'size'),
      f('hasLimitPx', 'presence-bool', 'limit_px'),
      f('limitPx', 'opt-uint64', 'limit_px'),
      f('expiryMs', 'uint64', 'expiry_ms'),
      f('hasStpGroup', 'presence-bool', 'stp_group'),
      f('stpGroup', 'opt-uint64', 'stp_group'),
    ],
  },
  // `rfq_quote` — a maker posts a quote onto an open RFQ session (161). The
  // numeric fields are RAW u64 wire values (fixed-point lots / price), digest-
  // symmetric with `rfq_request`; the optional `stp_group` flattens to a presence
  // bool + a u64 value.
  rfq_quote: {
    pascal: 'RfqQuote',
    wireType: 'rfq_quote',
    fields: [
      f('rfqId', 'uint64', 'rfq_id'),
      f('price', 'uint64', 'price'),
      f('maxSize', 'uint64', 'max_size'),
      f('validUntilMs', 'uint64', 'valid_until_ms'),
      f('hasStpGroup', 'presence-bool', 'stp_group'),
      f('stpGroup', 'opt-uint64', 'stp_group'),
    ],
  },
  rfq_accept: {
    pascal: 'RfqAccept',
    wireType: 'rfq_accept',
    fields: [
      f('rfqId', 'uint64', 'rfq_id'),
      f('quoteIdx', 'uint32', 'quote_idx'),
      f('size', 'uint64', 'size'),
    ],
  },
  fba_submit: {
    pascal: 'FbaSubmit',
    wireType: 'fba_submit',
    fields: [
      f('market', 'uint32', 'market'),
      f('side', 'side-u8', 'side'),
      f('size', 'uint64', 'size'),
      f('price', 'uint64', 'price'),
      f('hasStpGroup', 'presence-bool', 'stp_group'),
      f('stpGroup', 'opt-uint64', 'stp_group'),
    ],
  },
  // `pm_unenroll` — a NEW paramless /exchange tag that ALIASES the
  // `UserPortfolioMargin{enroll:false}` digest: SAME pascal + SAME `bool enroll`
  // field as `user_portfolio_margin`, but `enroll` is forced `false` and never
  // written to the wire (the bare `{"type":"pm_unenroll"}` envelope).
  pm_unenroll: {
    pascal: 'UserPortfolioMargin',
    wireType: 'pm_unenroll',
    fields: [f('enroll', 'const-false-bool', 'enroll')],
    emitNoParams: true,
  },
};

/// The set of snake_case `action.type` tags the typed scheme covers.
/// Spec keys a caller must NEVER name. They are variants of another action's
/// type string, selected from the params, and they carry that action's
/// `wireType` — listing them would advertise an action the server has no name
/// for.
const INTERNAL_SPEC_KEYS: ReadonlySet<string> = new Set(['core_evm_transfer_v2']);

export const TYPED_ACTION_TYPES: readonly string[] = Object.freeze(
  Object.entries(TYPED_SPECS)
    .filter(([k]) => !INTERNAL_SPEC_KEYS.has(k))
    .map(([, v]) => v.wireType),
);

/// Whether the given snake_case action type is one of the typed actions.
export function isTypedAction(actionType: string): boolean {
  return (
    !INTERNAL_SPEC_KEYS.has(actionType) &&
    Object.prototype.hasOwnProperty.call(TYPED_SPECS, actionType)
  );
}

/// Map a caller's action type onto the spec key its PARAMS select.
///
/// Only `core_evm_transfer` is polymorphic. PRESENCE is the selector, not
/// emptiness: an empty `data` and a `destination_chain_id` of `0` both choose
/// the V2 type string. An envelope with neither key digests byte-identically to
/// one built before those fields existed, so an existing caller is unaffected.
function resolveTypedKey(
  actionType: string,
  params: Readonly<Record<string, unknown>>,
): string {
  if (
    actionType === 'core_evm_transfer' &&
    (params.data !== undefined || params.destination_chain_id !== undefined)
  ) {
    return 'core_evm_transfer_v2';
  }
  return actionType;
}

function requireSpec(actionType: string): TypedSpec {
  const spec = TYPED_SPECS[actionType];
  if (spec === undefined) {
    throw new RangeError(
      `'${actionType}' is not a typed action (typed scheme covers: ${TYPED_ACTION_TYPES.join(', ')})`,
    );
  }
  return spec;
}

// ============================================================================
// encodeType / primaryType / types map
// ============================================================================

/// The account-set actions that take an agent-resolved params-level `owner`
/// (operator / vault trading). The orders set's owner-carrying actions live in
/// `./typed_orders.ts`. When an owner is bound the `address owner` word sits
/// right after `metafluxChain`, selecting the node's `*_WITH_OWNER_TYPE` —
/// byte-identical to the Rust SDK's `CANCEL_ALL_ORDERS_WITH_OWNER` shape.
///
/// ALL THREE RFQ ACTIONS BIND THE OWNER INTO THE DIGEST, unlike the order
/// actions, which carry `owner` on the wire only. The node records the taker at
/// request time and gates an accept on `requester == sender`, so an operator
/// must sign WHICH account it acts for. Omitting `owner` is not a rejection: the
/// request is admitted for the operator's OWN account, and the escrow and the
/// option position land on the operator wallet instead of the vault.
const ACCOUNT_OWNER_SUPPORTING: ReadonlySet<string> = new Set([
  'cancel_all_orders',
  'rfq_request',
  'rfq_quote',
  'rfq_accept',
]);

/// Whether `actionType` accepts a digest-level agent-resolved `owner`.
export function accountSupportsOwner(actionType: string): boolean {
  return ACCOUNT_OWNER_SUPPORTING.has(actionType);
}

/// Solidity type name for the encodeType string. Decimal fields are `string`;
/// the MetaBridge `chain-u8` field is a `uint8`; an optional field flattens to a
/// `bool` presence flag + a `uint32` value in the signed type.
function solidityTypeName(ty: FieldSolidityType): string {
  if (ty === 'string-decimal') return 'string';
  if (ty === 'string-decimal[]') return 'string[]';
  if (ty === 'chain-u8') return 'uint8';
  if (ty === 'vault-kind') return 'uint8';
  if (ty === 'side-u8') return 'uint8';
  if (ty === 'borrow-kind') return 'uint8';
  if (ty === 'presence-bool') return 'bool';
  if (ty === 'const-false-bool') return 'bool';
  if (ty === 'opt-uint32') return 'uint32';
  if (ty === 'opt-uint64') return 'uint64';
  if (ty === 'sentinel-uint64') return 'uint64';
  if (ty === 'bytes-hex') return 'bytes';
  if (ty === 'bytes[]-hex') return 'bytes[]';
  return ty;
}

/// Full encodeType string for a spec:
/// `MetaFluxTransaction:<Pascal>(string metafluxChain,<fields...>,uint64 nonce)`.
/// Pass `withOwner = true` to insert `address owner` right after
/// `string metafluxChain` for an owner-supporting action (operator / vault
/// trading); other actions ignore it and return the owner-less string.
export function encodeType(actionType: string, withOwner = false): string {
  const spec = requireSpec(actionType);
  const inner = ['string metafluxChain'];
  if (withOwner && ACCOUNT_OWNER_SUPPORTING.has(actionType)) {
    inner.push('address owner');
  }
  for (const fld of spec.fields) inner.push(`${solidityTypeName(fld.ty)} ${fld.name}`);
  inner.push('uint64 nonce');
  return `MetaFluxTransaction:${spec.pascal}(${inner.join(',')})`;
}

/// `MetaFluxTransaction:<Pascal>` — the EIP-712 primary type.
export function primaryType(actionType: string): string {
  return `MetaFluxTransaction:${requireSpec(actionType).pascal}`;
}

// ============================================================================
// Value reading + struct-hash word encoding. A field value is read from the
// action payload under its wireKey, validated, and rendered into a 32-byte
// struct-hash word + the structured JSON value for the v4 message / POST action.
// ============================================================================

/// uintN big-endian, zero-left-padded to 32 bytes; range-checked to the width.
function encUintWord(value: bigint, bits: number, field: string): Uint8Array {
  if (value < 0n) throw new RangeError(`${field} must be non-negative`);
  if (value >= 1n << BigInt(bits)) {
    throw new RangeError(`${field} overflows uint${bits}`);
  }
  return be32(value);
}

/// address -> 20 bytes right-aligned in a 32-byte word (12 zero-byte left pad).
function encAddrWord(addr: string, field: string): Uint8Array {
  validateAddress(addr, field);
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex), 12);
  return out;
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new RangeError(`${field} must be an integer`);
    return BigInt(value);
  }
  throw new RangeError(`${field} must be a number or bigint`);
}

function uintBits(ty: FieldSolidityType): number {
  switch (ty) {
    case 'uint8':
      return 8;
    case 'uint16':
      return 16;
    case 'uint32':
      return 32;
    case 'uint64':
      return 64;
    default:
      throw new RangeError(`not a uint type: ${ty}`);
  }
}

/// Validate a canonical decimal string (optional `-`, digits, optional single
/// fractional part). Rejects empty / malformed.
function validateDecimal(value: string, field: string): void {
  if (typeof value !== 'string') throw new RangeError(`${field} must be a decimal string`);
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    throw new RangeError(`${field} must be a canonical decimal string, got '${value}'`);
  }
}

function numberFor(v: bigint, field: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${field} exceeds Number.MAX_SAFE_INTEGER; not representable in the typed message`,
    );
  }
  return Number(v);
}

/// JSON value for the v4 `message` object (string | number | bool | string[]).
type MessageValue = string | number | boolean | string[];

/// One rendered field: a synchronous part (JSON fragment + message value) and
/// any byte buffers that must be keccak-hashed (async) to produce its word.
interface FieldPlan {
  /// snake_case key for the POST `action.params` object.
  readonly wireKey: string;
  /// camelCase key for the v4 `message` object.
  readonly name: string;
  /// JSON value string (e.g. `"0xabc"`, `123`, `true`, `["0x.."]`).
  readonly jsonValue: string;
  /// Structured value for the v4 `message`.
  readonly messageValue: MessageValue;
  /// When `true`, this field is signed but NOT written to the POST
  /// `action.params` JSON. Used by a flattened optional's presence half (the
  /// derived `hasX` bool — the server re-derives it from the optional wire key)
  /// and by an absent optional value (the key is simply omitted on the wire).
  readonly omitFromParams?: boolean;
  /// Produce the 32-byte struct-hash word (async: string/array fields keccak).
  word(): Promise<Uint8Array>;
}

function planField(fld: FieldSpec, payload: Record<string, unknown>): FieldPlan {
  const raw = payload[fld.wireKey];
  switch (fld.ty) {
    case 'string': {
      if (typeof raw !== 'string') throw new RangeError(`${fld.wireKey} must be a string`);
      return mkPlan(fld, jsonStr(raw), raw, () => keccak256(enc.encode(raw)));
    }
    case 'string-decimal': {
      const s = raw as string;
      validateDecimal(s, fld.wireKey);
      return mkPlan(fld, jsonStr(s), s, () => keccak256(enc.encode(s)));
    }
    case 'string-decimal[]': {
      // EIP-712 `string[]` over VERBATIM decimal strings: the signed word is
      // `keccak256(concat of per-element keccak256(utf8))`. Element ORDER is
      // signed, so `holders` and `amounts` stay row-aligned under the digest.
      if (!Array.isArray(raw)) {
        throw new RangeError(`${fld.wireKey} must be an array of decimal strings`);
      }
      const items = raw as string[];
      items.forEach((s, i) => validateDecimal(s, `${fld.wireKey}[${i}]`));
      const jsonValue = `[${items.map((s) => jsonStr(s)).join(',')}]`;
      return mkPlan(fld, jsonValue, [...items], async () => {
        const elemHashes = await Promise.all(items.map((s) => keccak256(enc.encode(s))));
        return keccak256(concatBytes(elemHashes));
      });
    }
    case 'borrow-kind': {
      // POST `params.kind` carries the STRING enum name; the signed word + v4
      // message value are the uint8 code (Lend=0, UnLend=1, Borrow=2, Repay=3).
      const code = typeof raw === 'string' ? BORROW_LEND_KIND_CODES[raw] : undefined;
      if (code === undefined) {
        throw new RangeError(
          `${fld.wireKey} must be one of: ${Object.keys(BORROW_LEND_KIND_CODES).join(', ')}`,
        );
      }
      const word = encUintWord(BigInt(code), 8, fld.wireKey);
      return mkPlan(fld, jsonStr(raw as string), code, async () => word);
    }
    case 'chain-u8': {
      // POST `params` carries the STRING chain name; the signed word + v4
      // message value are the uint8 code (Base=1, Arbitrum=2).
      const code = typeof raw === 'string' ? MB_CHAIN_CODES[raw] : undefined;
      if (code === undefined) {
        throw new RangeError(
          `${fld.wireKey} must be one of: ${Object.keys(MB_CHAIN_CODES).join(', ')}`,
        );
      }
      const word = encUintWord(BigInt(code), 8, fld.wireKey);
      return mkPlan(fld, jsonStr(raw as string), code, async () => word);
    }
    case 'vault-kind': {
      // POST `params` carries the STRING kind name (deserialized as the node's
      // `VaultKind` enum); the signed word + v4 message value are the uint8 code
      // (User=0, Metaliquidity=1). Omitted ⇒ `User`, matching the node's
      // `#[serde(default)]`.
      const name = raw === undefined || raw === null ? 'User' : raw;
      const code = typeof name === 'string' ? VAULT_KIND_CODES[name] : undefined;
      if (code === undefined) {
        throw new RangeError(
          `${fld.wireKey} must be one of: ${Object.keys(VAULT_KIND_CODES).join(', ')}`,
        );
      }
      const word = encUintWord(BigInt(code), 8, fld.wireKey);
      return mkPlan(fld, jsonStr(name as string), code, async () => word);
    }
    case 'side-u8': {
      // POST `params.side` carries the core `Side` STRING name ("Bid"/"Ask");
      // the signed word + v4 message value are the uint8 code (Bid=0, Ask=1).
      const code = typeof raw === 'string' ? SIDE_CODES[raw] : undefined;
      if (code === undefined) {
        throw new RangeError(
          `${fld.wireKey} must be one of: ${Object.keys(SIDE_CODES).join(', ')}`,
        );
      }
      const word = encUintWord(BigInt(code), 8, fld.wireKey);
      return mkPlan(fld, jsonStr(raw as string), code, async () => word);
    }
    case 'address': {
      const a = raw as string;
      const word = encAddrWord(a, fld.wireKey);
      return mkPlan(fld, jsonStr(a), a, async () => word);
    }
    case 'address[]': {
      if (!Array.isArray(raw)) throw new RangeError(`${fld.wireKey} must be an address array`);
      const addrs = raw as string[];
      const words = addrs.map((a, i) => encAddrWord(a, `${fld.wireKey}[${i}]`));
      const jsonValue = `[${addrs.map((a) => jsonStr(a)).join(',')}]`;
      return mkPlan(fld, jsonValue, [...addrs], () => keccak256(concatBytes(words)));
    }
    case 'bool': {
      if (typeof raw !== 'boolean') throw new RangeError(`${fld.wireKey} must be a boolean`);
      const word = encUintWord(raw ? 1n : 0n, 8, fld.wireKey);
      return mkPlan(fld, raw ? 'true' : 'false', raw, async () => word);
    }
    case 'const-false-bool': {
      // Always signs `false`; never written to the POST params (the wire is the
      // bare paramless tag). Backs the `pm_unenroll` → `UserPortfolioMargin`
      // `enroll=false` alias.
      const word = encUintWord(0n, 8, fld.wireKey);
      return mkPlan(fld, 'false', false, async () => word, true);
    }
    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64': {
      // An OPTIONAL uint (defaultUint set) reads its default when the wire key
      // is absent, matching the server's `#[serde(default)]`; a required uint
      // still throws on a missing value.
      const src = raw === undefined || raw === null ? fld.defaultUint : raw;
      const v = src === undefined ? asBigInt(raw, fld.wireKey) : asBigInt(src, fld.wireKey);
      const word = encUintWord(v, uintBits(fld.ty), fld.wireKey);
      return mkPlan(fld, v.toString(), numberFor(v, fld.wireKey), async () => word);
    }
    case 'presence-bool': {
      // The derived presence half of a flattened optional. Signs `true`/`false`
      // for present/absent of the (shared) wire key; never written to POST
      // params (the server re-derives it from the optional key).
      const present = isPresent(raw);
      const word = encUintWord(present ? 1n : 0n, 8, fld.wireKey);
      return mkPlan(fld, present ? 'true' : 'false', present, async () => word, true);
    }
    case 'opt-uint32': {
      // The value half of a flattened optional. Signs the uint32 value, or `0`
      // when absent (matching the server's `Option::unwrap_or(0)`). On the wire
      // the optional key is emitted ONLY when present (omitted otherwise).
      const present = isPresent(raw);
      const v = present ? asBigInt(raw, fld.wireKey) : 0n;
      const word = encUintWord(v, 32, fld.wireKey);
      return mkPlan(
        fld,
        v.toString(),
        numberFor(v, fld.wireKey),
        async () => word,
        !present,
      );
    }
    case 'opt-uint64': {
      // The 64-bit value half of a flattened optional. Signs the uint64 value,
      // or `0` when absent (matching the server's `Option::unwrap_or(0)`). On the
      // wire the optional key is emitted ONLY when present (omitted otherwise).
      const present = isPresent(raw);
      const v = present ? asBigInt(raw, fld.wireKey) : 0n;
      const word = encUintWord(v, 64, fld.wireKey);
      return mkPlan(fld, v.toString(), numberFor(v, fld.wireKey), async () => word, !present);
    }
    case 'sentinel-uint64': {
      // An optional u64 with NO presence half: absent signs `0` and omits the
      // key. An explicit `0` is refused — it digests identically to absent, and
      // the node refuses that wire form for the same reason.
      const present = isPresent(raw);
      const v = present ? asBigInt(raw, fld.wireKey) : 0n;
      if (present && v === 0n) {
        throw new RangeError(
          `${fld.wireKey}: an explicit 0 is ambiguous (the signed digest cannot ` +
            `tell it from an absent field); omit the field instead`,
        );
      }
      const word = encUintWord(v, 64, fld.wireKey);
      return mkPlan(fld, v.toString(), numberFor(v, fld.wireKey), async () => word, !present);
    }
    case 'bytes': {
      // `Uint8Array` POSTed as a JSON byte array (the server's native wire
      // form); hashed `keccak256(raw)`. The v4 message renders it as `0x`-hex.
      const bytes = asByteArray(raw, fld.wireKey);
      const jsonValue = `[${Array.from(bytes).join(',')}]`;
      return mkPlan(fld, jsonValue, `0x${toHex(bytes)}`, () => keccak256(bytes));
    }
    case 'bytes32': {
      // A fixed 32-byte buffer carried verbatim into one word; POSTed as a JSON
      // byte array. The v4 message renders it as `0x`-hex.
      const bytes = asByteArray(raw, fld.wireKey);
      if (bytes.length !== 32) {
        throw new RangeError(`${fld.wireKey} must be exactly 32 bytes`);
      }
      const word = bytes.slice();
      const jsonValue = `[${Array.from(bytes).join(',')}]`;
      return mkPlan(fld, jsonValue, `0x${toHex(bytes)}`, async () => word);
    }
    case 'bytes-hex': {
      // A dynamic `bytes` value carried as a `0x`-hex STRING on the wire (the
      // multi-sig wrapper's `inner_action_blob`). The signed word is
      // `keccak256(decoded bytes)`; the v4 message + POST value are the hex string.
      const hex = normalizeHex(raw, fld.wireKey);
      const bytes = hexToBytes(hex.slice(2));
      return mkPlan(fld, jsonStr(hex), hex, () => keccak256(bytes));
    }
    case 'bytes[]-hex': {
      // A `bytes[]` value carried as an ARRAY of `0x`-hex STRINGs on the wire
      // (the multi-sig wrapper's `signatures`). The signed word is
      // `keccak256(concat of per-element keccak256(decoded))`; the v4 message +
      // POST value are the hex-string array. Element + array order is significant.
      if (!Array.isArray(raw)) {
        throw new RangeError(`${fld.wireKey} must be an array of 0x-hex strings`);
      }
      const hexes = raw.map((v, i) => normalizeHex(v, `${fld.wireKey}[${i}]`));
      const jsonValue = `[${hexes.map((h) => jsonStr(h)).join(',')}]`;
      return mkPlan(fld, jsonValue, [...hexes], async () => {
        const elemHashes = await Promise.all(
          hexes.map((h) => keccak256(hexToBytes(h.slice(2)))),
        );
        return keccak256(concatBytes(elemHashes));
      });
    }
  }
}

/// Normalize a `0x`-hex string wire value: require the `0x` prefix and an
/// even-length hex body. Returns the canonical lowercase-agnostic `0x…` form (the
/// exact string signed + POSTed). Rejects non-string / malformed input.
function normalizeHex(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new RangeError(`${field} must be a 0x-prefixed hex string`);
  }
  if (!raw.startsWith('0x')) {
    throw new RangeError(`${field} must be 0x-prefixed`);
  }
  const body = raw.slice(2);
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new RangeError(`${field} must be even-length hex`);
  }
  return raw;
}

/// Whether an optional wire value is present (non-`null`, non-`undefined`).
function isPresent(raw: unknown): boolean {
  return raw !== undefined && raw !== null;
}

/// Read a `bytes` / `bytes32` field as a `Uint8Array`.
function asByteArray(raw: unknown, field: string): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw) && raw.every((b) => typeof b === 'number')) {
    return Uint8Array.from(raw as number[]);
  }
  throw new RangeError(`${field} must be a Uint8Array (or array of byte numbers)`);
}

function mkPlan(
  fld: FieldSpec,
  jsonValue: string,
  messageValue: MessageValue,
  word: () => Promise<Uint8Array>,
  omitFromParams = false,
): FieldPlan {
  return {
    wireKey: fld.wireKey,
    name: fld.name,
    jsonValue,
    messageValue,
    omitFromParams,
    word,
  };
}

/// Concatenate equal-length 32-byte words into one buffer.
function concatBytes(words: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(words.length * 32);
  words.forEach((w, i) => out.set(w, i * 32));
  return out;
}

// ============================================================================
// Digest, signTypedData_v4 payload, sign / recover, POST body.
// ============================================================================

/// A built typed action: the snake_case `action` JSON POSTed to `/exchange`,
/// the chain id + nonce bound into it, and the ordered field plans.
interface BuiltTyped {
  readonly actionType: string;
  readonly chainId: number;
  readonly chainTag: MetafluxChainTag;
  readonly nonce: bigint;
  /// Action-specific field plans (excludes metafluxChain + nonce).
  readonly plans: readonly FieldPlan[];
  /// The exact `action` JSON string to POST (and that the digest covers).
  readonly actionJson: string;
  /// The agent-resolved owner bound into the digest (owner-supporting actions
  /// only — operator / vault trading). `undefined` for an owner-less digest. When
  /// set, `address owner` enters the encodeType + struct hash right after
  /// `metafluxChain`, and the wire `params` carries the `owner` key (the node
  /// reads it back to reconstruct the same `*_WITH_OWNER` digest).
  readonly owner?: string;
  /// OPTIONAL top-level action-expiry (unix-ms). `0n` = never expires and the
  /// digest is BYTE-IDENTICAL to the pre-existing (no-expiry) form. When
  /// non-zero, `,uint64 expiresAfter` is folded into the encodeType string and
  /// one trailing `uint256(expiresAfter)` word is appended after the nonce word.
  readonly expiresAfter: bigint;
}

/// Build a typed action from a snake_case payload. `payload` carries ONLY the
/// action-specific fields under their snake_case wire keys (no metafluxChain /
/// nonce). The POST `action` JSON is `{"type":<wireType>,"params":{...}}`.
export function buildTyped(
  actionType: string,
  payload: Record<string, unknown>,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
  owner?: string,
  expiresAfter: bigint = 0n,
): BuiltTyped {
  if (nonce < 0n) throw new RangeError('nonce must be non-negative');
  if (nonce >= 1n << 64n) throw new RangeError('nonce overflows u64');
  if (expiresAfter < 0n) throw new RangeError('expiresAfter must be non-negative');
  if (expiresAfter >= 1n << 64n) throw new RangeError('expiresAfter overflows u64');
  // The params can select a different type string for the same wire action, so
  // the key is resolved ONCE here. `BuiltTyped.actionType` then carries the
  // resolved key, which is what every later lookup reads.
  actionType = resolveTypedKey(actionType, payload);
  if (actionType === 'core_evm_transfer_v2') {
    // Presence of EITHER key selects V2, but V2 signs BOTH. The absent one
    // encodes as its default, matching the server's `unwrap_or_default`.
    payload = {
      ...payload,
      data: payload.data ?? [],
      destination_chain_id: payload.destination_chain_id ?? 0,
    };
  }
  const spec = requireSpec(actionType);
  const chainTag = metafluxChainTag(chainId);
  // The agent-resolved `owner` binds only for owner-supporting actions (operator
  // / vault trading); other actions ignore a passed owner, matching the Rust SDK.
  const ownerBound = owner !== undefined && ACCOUNT_OWNER_SUPPORTING.has(actionType);
  if (ownerBound) validateAddress(owner, 'owner');
  const plans = spec.fields.map((fld) => planField(fld, payload));
  // The POST `action.params` omits flattened-optional presence flags and absent
  // optional values (`omitFromParams`), so the wire shape matches the server's
  // native action exactly while every spec field is still signed. When an owner
  // is bound it rides in `params.owner` (the key the node reads back); its
  // position in the JSON object is irrelevant to the digest (which covers the
  // EIP-712 struct, not the bytes), so it is emitted first for readability.
  const fieldParams = plans
    .filter((p) => !p.omitFromParams)
    .map((p) => `${jsonStr(p.wireKey)}:${p.jsonValue}`);
  const paramEntries = ownerBound
    ? [`${jsonStr('owner')}:${jsonStr(owner)}`, ...fieldParams]
    : [...fieldParams];
  // `multi_sig` also carries the wrapper nonce inside `params` (a required serde
  // field on the node's `NativeMultiSig`); same value as the envelope nonce and
  // the last signed word, so the digest is unaffected. Emitted as a bare u64.
  if (spec.emitNonceInParams === true) {
    paramEntries.push(`${jsonStr('nonce')}:${nonce}`);
  }
  // A paramless alias (`pm_unenroll`) emits the bare `{"type":<wireType>}`
  // envelope when no field contributes a wire param, matching the node.
  const actionJson =
    spec.emitNoParams === true && paramEntries.length === 0
      ? `{${jsonStr('type')}:${jsonStr(spec.wireType)}}`
      : `{${jsonStr('type')}:${jsonStr(spec.wireType)},${jsonStr('params')}:{${paramEntries.join(',')}}}`;
  return {
    actionType,
    chainId,
    chainTag,
    nonce,
    plans,
    actionJson,
    owner: ownerBound ? owner : undefined,
    expiresAfter,
  };
}

/// Fold the OPTIONAL top-level `expiresAfter` into an encodeType string: splice
/// `,uint64 expiresAfter` in just before the closing paren. Mirrors the chain's
/// `folded_type_hash` — one uniform transform for EVERY typed action. Returns the
/// base string unchanged when `expiresAfter === 0n` (byte-identical digest).
export function foldExpiryTypeString(base: string, expiresAfter: bigint): string {
  if (expiresAfter === 0n) return base;
  if (!base.endsWith(')')) {
    throw new RangeError('encodeType string must end in ")"');
  }
  return `${base.slice(0, -1)},uint64 expiresAfter)`;
}

/// Compute the EIP-712 domain separator (4-field: name, version, chainId,
/// verifyingContract=0x0).
async function domainSeparator(chainId: number): Promise<Uint8Array> {
  const typeHash = await keccak256(enc.encode(EIP712_DOMAIN_TYPE));
  const nameHash = await keccak256(enc.encode('MetaFlux'));
  const versionHash = await keccak256(enc.encode('1'));
  const chainIdBe = be32(BigInt(chainId));
  const verifyingPadded = new Uint8Array(32); // 0x0 address, all zeros.
  const buf = new Uint8Array(5 * 32);
  buf.set(typeHash, 0);
  buf.set(nameHash, 32);
  buf.set(versionHash, 64);
  buf.set(chainIdBe, 96);
  buf.set(verifyingPadded, 128);
  return keccak256(buf);
}

/// `hashStruct(s) = keccak256(typeHash || encodeData)` where encodeData is the
/// metafluxChain word, then each action field's word, then the nonce word.
async function hashStruct(built: BuiltTyped): Promise<Uint8Array> {
  const typeHash = await keccak256(
    enc.encode(
      foldExpiryTypeString(
        encodeType(built.actionType, built.owner !== undefined),
        built.expiresAfter,
      ),
    ),
  );
  const chainWord = await keccak256(enc.encode(built.chainTag));
  // Agent-resolved owner: bound right after metafluxChain (owner-supporting
  // actions only). Absent ⇒ no word, digest byte-identical to the owner-less form.
  const ownerWords =
    built.owner !== undefined ? [encAddrWord(built.owner, 'owner')] : [];
  const fieldWords = await Promise.all(built.plans.map((p) => p.word()));
  const nonceWord = be32(built.nonce);
  // OPTIONAL expiry: one trailing `uint256(expiresAfter)` word AFTER the nonce
  // word, ONLY when non-zero (matching the chain's `hash_struct_with_expiry`).
  const expiryWords =
    built.expiresAfter !== 0n ? [be32(built.expiresAfter)] : [];
  const words = [
    typeHash,
    chainWord,
    ...ownerWords,
    ...fieldWords,
    nonceWord,
    ...expiryWords,
  ];
  return keccak256(concatBytes(words));
}

/// Full EIP-712 digest for a typed action:
/// `keccak256(0x19 0x01 || domainSeparator || hashStruct)`.
export async function typedActionDigest(built: BuiltTyped): Promise<Uint8Array> {
  const domainSep = await domainSeparator(built.chainId);
  const structHash = await hashStruct(built);
  const envelope = new Uint8Array(2 + 32 + 32);
  envelope[0] = 0x19;
  envelope[1] = 0x01;
  envelope.set(domainSep, 2);
  envelope.set(structHash, 34);
  return keccak256(envelope);
}

/// The `eth_signTypedData_v4` payload object for a typed action.
///
/// This is the wallet-facing structure: pass it (JSON-stringified) as the
/// second parameter of an `eth_signTypedData_v4` RPC request. `types` lists the
/// fields in the SAME order as the encodeType string; `domain` is the 4-field
/// MTF domain (no salt); `primaryType` is `MetaFluxTransaction:<Pascal>`.
export interface TypedDataV4 {
  readonly domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  readonly types: Record<string, { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, MessageValue>;
}

/// Build the `eth_signTypedData_v4` payload for a typed action.
export function typedDataV4(built: BuiltTyped): TypedDataV4 {
  const spec = requireSpec(built.actionType);
  const fields: { name: string; type: string }[] = [
    { name: 'metafluxChain', type: 'string' },
  ];
  // Agent-resolved owner sits right after metafluxChain, matching the encodeType
  // string + struct-hash word order.
  if (built.owner !== undefined) {
    fields.push({ name: 'owner', type: 'address' });
  }
  for (const fld of spec.fields) {
    fields.push({ name: fld.name, type: solidityTypeName(fld.ty) });
  }
  fields.push({ name: 'nonce', type: 'uint64' });
  // OPTIONAL expiry: the wallet renders + signs it as the trailing `uint64`
  // field, ONLY when non-zero (matching the folded encodeType + struct word).
  if (built.expiresAfter !== 0n) {
    fields.push({ name: 'expiresAfter', type: 'uint64' });
  }

  const message: Record<string, MessageValue> = { metafluxChain: built.chainTag };
  if (built.owner !== undefined) message['owner'] = built.owner;
  for (const p of built.plans) message[p.name] = p.messageValue;
  // nonce rides the v4 message as a decimal string (uint64 may exceed 2^53).
  message['nonce'] = built.nonce.toString();
  if (built.expiresAfter !== 0n) {
    message['expiresAfter'] = built.expiresAfter.toString();
  }

  return {
    domain: {
      name: 'MetaFlux',
      version: '1',
      chainId: built.chainId,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [primaryType(built.actionType)]: fields,
    },
    primaryType: primaryType(built.actionType),
    message,
  };
}

/// A signed typed action ready for `POST /exchange` with the typed `/exchange`.
export interface TypedSignedAction {
  /// The exact `action` JSON string (signed + POSTed verbatim).
  readonly actionJson: string;
  /// The envelope nonce (also bound inside the typed struct).
  readonly nonce: bigint;
  /// 65-byte `r||s||v` signature, `0x`-hex.
  readonly signature: string;
  /// OPTIONAL top-level action-expiry (unix-ms) folded into the signed digest.
  /// `0n` / absent = never expires and the wire body OMITS `expires_after`
  /// (byte-identical to the pre-existing envelope).
  readonly expiresAfter?: bigint;
}

/// Sign a typed action with a 32-byte private key (the local / keypair path,
/// for agents and tests). Builds the same 0x1901 digest a wallet's
/// `eth_signTypedData_v4` would, over the v4 payload from [`typedDataV4`].
export async function signTypedAction(
  privateKey: Uint8Array,
  actionType: string,
  payload: Record<string, unknown>,
  nonce: bigint,
  chainId: number = MTF_CHAIN_ID,
  owner?: string,
  expiresAfter: bigint = 0n,
): Promise<TypedSignedAction> {
  if (privateKey.length !== 32) throw new RangeError('privateKey must be exactly 32 bytes');
  const built = buildTyped(actionType, payload, nonce, chainId, owner, expiresAfter);
  const digest = await typedActionDigest(built);
  const sig = await signSecp256k1(privateKey, digest);
  return {
    actionJson: built.actionJson,
    nonce,
    signature: `0x${toHex(sig)}`,
    expiresAfter,
  };
}

/// Recover the 20-byte signer address of a signed typed action — handy for a
/// pre-POST owner assertion. Rebuilds the digest from the signed `action` JSON.
export async function recoverTypedSigner(
  signed: TypedSignedAction,
  actionType: string,
  payload: Record<string, unknown>,
  chainId: number = MTF_CHAIN_ID,
  owner?: string,
): Promise<string> {
  const built = buildTyped(
    actionType,
    payload,
    signed.nonce,
    chainId,
    owner,
    signed.expiresAfter ?? 0n,
  );
  const digest = await typedActionDigest(built);
  const sigHex = signed.signature.startsWith('0x')
    ? signed.signature.slice(2)
    : signed.signature;
  const pubkey = await recoverPubkey(hexToBytes(sigHex), digest);
  const addr = await deriveAddressFromPubkey(pubkey);
  return `0x${toHex(addr)}`;
}

/// Assemble the `POST /exchange` request body STRING:
/// `{"action":<actionJson>,"nonce":<u64>,"signature":"0x.."}`.
/// The `action` bytes are embedded verbatim (the signed bytes == the sent bytes).
export function typedRequestBody(signed: TypedSignedAction): string {
  // The OPTIONAL top-level `expires_after` is appended ONLY when non-zero — a
  // `0n`/absent expiry OMITS the field, keeping the wire bytes byte-identical to
  // the pre-existing envelope (and the node reads the same no-expiry digest).
  const expiry =
    signed.expiresAfter !== undefined && signed.expiresAfter !== 0n
      ? `,${jsonStr('expires_after')}:${signed.expiresAfter}`
      : '';
  return (
    `{${jsonStr('action')}:${signed.actionJson},` +
    `${jsonStr('nonce')}:${signed.nonce},` +
    `${jsonStr('signature')}:${jsonStr(signed.signature)}${expiry}}`
  );
}
