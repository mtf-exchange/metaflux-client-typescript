// `Client` — primary entry point for the @metaflux-dex/client SDK.
//
// Heavy lifting: order signing (msgpack encode -> EIP-712 hash ->
// secp256k1 sign -> address derive) runs through WASM. Pure-TS
// responsibilities: HTTP plumbing, type coercion, optional JWT
// session bookkeeping.
//
// Naming note: exported as `Client` (NOT `MtfClient`) per session
// direction. Consumers import as `import { Client } from '@metaflux-dex/client'`.

import {
  deriveAddressFromPubkey,
  eip712TypedDataHash,
  encodeLimitOrder,
  keccak256,
  recoverPubkey,
  signSecp256k1,
} from './wallet/wasm.js';
import { httpRequest } from './rest/http.js';
import {
  buildNativeAgentSetAbstractionAction,
  buildNativeApproveAgentAction,
  buildNativeApproveBuilderFeeAction,
  buildNativeBatchCancelAction,
  buildNativeBatchModifyAction,
  buildNativeBatchOrderAction,
  buildNativeCancelAction,
  buildNativeCancelAllOrdersAction,
  buildNativeCancelByCloidAction,
  buildNativeClaimRewardsAction,
  buildNativeConvertToMultiSigUserAction,
  buildNativeCreateVaultAction,
  buildNativeEarnDepositAction,
  buildNativeEarnWithdrawAction,
  buildNativeLinkStakingUserAction,
  buildNativeMbWithdrawAction,
  buildNativeModifyAction,
  buildNativeOrderAction,
  buildNativePriorityBidAction,
  buildNativeRegisterMetaliquidityOperatorAction,
  buildNativeScheduleCancelAction,
  buildNativeSetDisplayNameAction,
  buildNativeSetMetaliquidityWhitelistAction,
  buildNativeSetPositionModeAction,
  buildNativeSetReferrerAction,
  buildNativeSpotCancelAction,
  buildNativeSpotMarginCloseAction,
  buildNativeSpotMarginDepositAction,
  buildNativeSpotMarginOpenAction,
  buildNativeSpotMarginWithdrawAction,
  buildNativeSpotOrderAction,
  buildNativeSubmitEncryptedOrderAction,
  buildNativeTokenDelegateAction,
  buildNativeTopUpIsolatedOnlyMarginAction,
  buildNativeTwapCancelAction,
  buildNativeTwapOrderAction,
  buildNativeUpdateIsolatedMarginAction,
  buildNativeUpdateLeverageAction,
  buildNativeUserDexAbstractionAction,
  buildNativeUserPortfolioMarginAction,
  buildNativeUserSetAbstractionAction,
  buildNativeVaultModifyAction,
  buildNativeVaultTransferAction,
  buildNativeVaultWithdrawAction,
} from './native/actions.js';
import {
  nativeRequestBody,
  nextNonce,
  recoverNativeSigner,
  signNativeAction,
} from './native/digest.js';
import { InfoApi } from './rest/info.js';
import { WsClient, type WsConfig } from './ws/ws.js';
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
  CreateVault,
  LinkStakingUser,
  Market,
  MbWithdraw,
  Modify,
  NativeCancel,
  NativeEarnDeposit,
  NativeEarnWithdraw,
  NativeExchangeAck,
  NativeOrder,
  NativeSetPositionMode,
  NativeSpotCancel,
  NativeSpotMarginClose,
  NativeSpotMarginDeposit,
  NativeSpotMarginOpen,
  NativeSpotMarginWithdraw,
  NativeSpotOrder,
  Order,
  OrderAck,
  Position,
  PriorityBid,
  RegisterMetaliquidityOperator,
  ScheduleCancel,
  SetDisplayName,
  SetMetaliquidityWhitelist,
  SetReferrer,
  SignedOrder,
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
  VaultModify,
  VaultTransfer,
  VaultWithdraw,
} from './types/index.js';

/// Options accepted by the `Client` constructor.
export interface ClientOpts {
  /// Gateway base URL — e.g. `https://api.metaflux.example`. The Client
  /// appends CCXT-compat paths (`/ccxt/...`) and MTF-native paths
  /// (`/v1/...`) under this root.
  baseUrl: string;
  /// Optional 32-byte ECDSA private key. Required for any signing
  /// operation (`signOrder`); read-only data calls (`getMarkets`,
  /// `getPositions`) work without it.
  privateKey?: Uint8Array;
  /// EVM chain ID used for the EIP-712 domain. Defaults to a
  /// devnet-style placeholder (`31337`); production deployments override.
  chainId?: number;
}

/// Default chain ID for the EIP-712 domain. The devnet default `31337`
/// matches the node's devnet configuration; production deployments
/// override via `chainId`.
const DEFAULT_CHAIN_ID = 31337;

/// `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
/// pre-computed at module load. Static across the SDK lifetime so we
/// don't re-keccak it for every signing call.
let cachedDomainTypeHash: Uint8Array | undefined;
async function domainTypeHash(): Promise<Uint8Array> {
  if (cachedDomainTypeHash === undefined) {
    cachedDomainTypeHash = await keccak256(
      new TextEncoder().encode(
        'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
      ),
    );
  }
  return cachedDomainTypeHash;
}

/// Pre-computed type-hash for the limit-order action. The string mirrors
/// what the node will register for the `Order` action — locked in by
/// RFC-001 §D once the on-chain registry lands. The shape here matches
/// what `encode_limit_order` produces.
let cachedOrderTypeHash: Uint8Array | undefined;
async function orderTypeHash(): Promise<Uint8Array> {
  if (cachedOrderTypeHash === undefined) {
    cachedOrderTypeHash = await keccak256(
      new TextEncoder().encode(
        'Order(uint32 asset,uint8 side,uint128 px,uint128 size,uint8 tif)',
      ),
    );
  }
  return cachedOrderTypeHash;
}

/// Compute the EIP-712 domain separator for a given chain id.
///
/// Mirrors `core_state::signing::EipDomain::separator` — the canonical
/// 5-segment keccak input is
/// `(domain_type_hash, name_hash, version_hash, chain_id_be32, verifying_contract_padded)`.
async function computeDomainSeparator(chainId: number): Promise<Uint8Array> {
  const dth = await domainTypeHash();
  const nameHash = await keccak256(new TextEncoder().encode('MetaFlux'));
  const versionHash = await keccak256(new TextEncoder().encode('1'));

  // uint256 chainId big-endian, 32 bytes.
  const chainIdBe = new Uint8Array(32);
  // JS bitwise ops are signed 32-bit; use BigInt for the conversion.
  const view = new DataView(chainIdBe.buffer);
  view.setBigUint64(24, BigInt(chainId)); // low 8 bytes carry the value.

  // Verifying contract == Address::ZERO, left-padded to 32 bytes -> all zeros.
  const verifyingPadded = new Uint8Array(32);

  // Concat + keccak. Allocating one Uint8Array beats 5 hasher.update calls
  // because the WASM keccak primitive takes a single slice — the
  // call-overhead of multiple FFI hops would outweigh the copy.
  const concat = new Uint8Array(5 * 32);
  concat.set(dth, 0);
  concat.set(nameHash, 32);
  concat.set(versionHash, 64);
  concat.set(chainIdBe, 96);
  concat.set(verifyingPadded, 128);
  return keccak256(concat);
}

/// Primary client surface. Construct once per session.
///
/// Read-only example:
/// ```ts
/// const c = new Client({ baseUrl: 'http://localhost:8080' });
/// const markets = await c.getMarkets();
/// ```
///
/// Signing example:
/// ```ts
/// const c = new Client({
///   baseUrl: 'http://localhost:8080',
///   privateKey: hexToBytes('...'),
/// });
/// const signed = await c.signOrder({ asset: 0, side: 0, sizeE8: 100_000_000n,
///                                    priceE8: 50_000_00000000n, tif: 0 });
/// const ack = await c.submitOrder(signed);
/// ```
export class Client {
  private readonly baseUrl: string;
  private readonly privateKey: Uint8Array | undefined;
  private readonly chainId: number;
  /// Cached gateway-issued JWT (`/auth`). The session is established
  /// lazily on the first authenticated call.
  private jwt: string | undefined;
  /// MTF-native read API (`POST /info`). Read-only; no key required.
  readonly info: InfoApi;

  constructor(opts: ClientOpts) {
    if (opts.baseUrl.length === 0) {
      throw new RangeError('Client baseUrl must be non-empty');
    }
    if (opts.privateKey !== undefined && opts.privateKey.length !== 32) {
      throw new RangeError('Client privateKey must be exactly 32 bytes');
    }
    this.baseUrl = opts.baseUrl;
    this.privateKey = opts.privateKey;
    this.chainId = opts.chainId ?? DEFAULT_CHAIN_ID;
    this.info = new InfoApi(this.baseUrl);
  }

  /// Whether this client has a private key available for signing
  /// operations. Read-only data calls work regardless.
  get canSign(): boolean {
    return this.privateKey !== undefined;
  }

  /// Sign an order body. Returns the `(payload, signature, signer)`
  /// triplet ready for `submitOrder`.
  ///
  /// All heavy lifting (msgpack encode, keccak, ECDSA) is in WASM.
  /// The signing flow:
  ///
  /// 1. `payload = encode_limit_order(...)` — msgpack body matching the
  ///    node's `OrderParams` decoder.
  /// 2. `messageHash = keccak256(orderTypeHash || payload)` — the
  ///    EIP-712 "struct hash" of the action.
  /// 3. `domainSeparator = keccak256(EIP712Domain(...))` — cached.
  /// 4. `digest = keccak256(0x1901 || domainSeparator || messageHash)`.
  /// 5. `signature = sign_secp256k1(privateKey, digest)`.
  /// 6. `signer = derive_address_from_pubkey(recover_pubkey(signature, digest))`.
  ///
  /// Step 6 derives the signer locally rather than trusting the gateway
  /// to recover it; that way the SDK ships the address upfront and the
  /// gateway can reject obviously-replayed envelopes before doing ECDSA.
  async signOrder(order: Order): Promise<SignedOrder> {
    if (this.privateKey === undefined) {
      throw new Error(
        'signOrder requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const payload = await encodeLimitOrder(
      order.asset,
      order.side,
      order.sizeE8,
      order.priceE8,
      order.tif,
      order.stp ?? 0,
      order.cloid,
      order.reduceOnly ?? false,
      order.builder,
    );
    const typeHash = await orderTypeHash();
    // message_hash = keccak256(type_hash || payload).
    const msgBuffer = new Uint8Array(typeHash.length + payload.length);
    msgBuffer.set(typeHash, 0);
    msgBuffer.set(payload, typeHash.length);
    const messageHash = await keccak256(msgBuffer);

    const domainSeparator = await computeDomainSeparator(this.chainId);
    const digest = await eip712TypedDataHash(domainSeparator, messageHash);

    const signature = await signSecp256k1(this.privateKey, digest);
    const pubkey = await recoverPubkey(signature, digest);
    const signer = await deriveAddressFromPubkey(pubkey);

    return { payload, signature, signer };
  }

  /// Submit a pre-signed order to the gateway.
  ///
  /// DEPRECATED / LEGACY: this targets the old `{payload,signature,signer}` →
  /// `/v1/orders` envelope with a msgpack body and an `Order(...)` typehash.
  /// The server now accepts the MTF-native `{action,nonce,signature}` →
  /// `/exchange` envelope instead — use `submitOrderNative`. Retained
  /// only for any consumer still on the old gateway adapter.
  ///
  /// Wire shape: POSTs the `SignedOrder` as a msgpack-friendly JSON
  /// envelope — `payload` and `signature` go as base64url strings (the
  /// gateway's existing `LoginEnvelope` shape uses base64; we mirror
  /// that), `signer` goes as a 0x-hex address. The gateway adapter
  /// (TODO on the server side) decodes and forwards to the node via
  /// gRPC; for now the SDK targets the CCXT createOrder response shape.
  async submitOrder(signed: SignedOrder): Promise<OrderAck> {
    return httpRequest<OrderAck>(this.baseUrl, '/v1/orders', {
      method: 'POST',
      json: {
        payload: bytesToBase64Url(signed.payload),
        signature: bytesToBase64Url(signed.signature),
        signer: bytesToHex(signed.signer, '0x'),
      },
      bearer: this.jwt,
    });
  }

  /// Submit an order via the MTF-native signed-action front door
  /// (`POST /exchange`).
  ///
  /// This is the path the server now accepts. It supersedes the legacy
  /// `signOrder` + `submitOrder` flow (msgpack body + `Order(...)` typehash +
  /// `{payload,signature,signer}` → `/v1/orders`), which targeted an
  /// envelope the node no longer recognizes.
  ///
  /// Flow:
  /// 1. `buildNativeOrderAction` produces the canonical snake_case action JSON
  ///    string (`{"type":"submit_order","order":{...}}`), field order matching
  ///    the server `NativeOrder`.
  /// 2. `signNativeAction` computes the native EIP-712 digest over the EXACT
  ///    action bytes (`MetaFluxAction(string action,uint64 nonce)` struct hash,
  ///    5-field domain) and signs it.
  /// 3. The action string is POSTed VERBATIM inside `{action, nonce, signature}`
  ///    — the server recovers the signer over the raw `action` bytes, so the
  ///    signed bytes and the sent bytes are identical.
  ///
  /// `order.owner` MUST equal the signing wallet's address; we recover the
  /// signer locally and reject a mismatch before hitting the network (the
  /// server enforces the same).
  ///
  /// `nonce` is the per-owner replay nonce bound into the digest. Defaults to
  /// `Date.now()` (unix-ms) — supply an explicit monotonically-increasing
  /// value for back-to-back submissions in the same millisecond.
  ///
  /// `chainId` defaults to the MTF-native chain id (`MTF_CHAIN_ID` = testnet
  /// 114514; mainnet is 8964), independent of the legacy `ClientOpts.chainId`
  /// (which is the wrong domain for this path).
  async submitOrderNative(
    order: NativeOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'submitOrderNative requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const actionJson = buildNativeOrderAction(order);
    const signed = await signNativeAction(
      this.privateKey,
      actionJson,
      nonce,
      opts.chainId,
    );

    // Local guard: the recovered signer must equal the claimed owner. The
    // server enforces this too (401 on mismatch), but failing here saves a
    // round-trip and surfaces a key/owner mismatch with a clear message.
    const signer = await recoverNativeSigner(signed, opts.chainId);
    if (signer.toLowerCase() !== order.owner.toLowerCase()) {
      throw new Error(
        `order.owner ${order.owner} != recovered signer ${signer}`,
      );
    }

    return httpRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: nativeRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Cancel an order via the MTF-native signed-action front door
  /// (`POST /exchange`).
  ///
  /// Same envelope + verification model as `submitOrderNative`: the
  /// `cancel_order` action JSON is built canonically, signed over the EIP-712
  /// native digest, and POSTed verbatim. The server cancels by `oid`, so
  /// `cancel.oid` must be set (a `cloid`-only cancel is rejected at lowering).
  ///
  /// `cancel.owner` MUST equal the signing wallet; we recover the signer
  /// locally and reject a mismatch before hitting the network.
  async cancelOrderNative(
    cancel: NativeCancel,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'cancelOrderNative requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const actionJson = buildNativeCancelAction(cancel);
    const signed = await signNativeAction(
      this.privateKey,
      actionJson,
      nonce,
      opts.chainId,
    );

    const signer = await recoverNativeSigner(signed, opts.chainId);
    if (signer.toLowerCase() !== cancel.owner.toLowerCase()) {
      throw new Error(
        `cancel.owner ${cancel.owner} != recovered signer ${signer}`,
      );
    }

    return httpRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: nativeRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Toggle one-way / hedge position mode via `POST /exchange`.
  ///
  /// `setPositionMode({ hedge: true })` switches the account to hedge / two-way
  /// mode; `{ hedge: false }` switches back to one-way / net. Same signed-action
  /// envelope as the order paths, but SENDER-AUTHORIZED: the recovered signer IS
  /// the account, so there is no `owner` to cross-check. The node only permits
  /// the switch while the account is flat on every market (else it 4xxs).
  ///
  /// After switching to hedge mode, perp orders MUST carry `position_side`
  /// (`"long"` / `"short"`); after switching back to one-way they MUST omit it.
  async setPositionMode(
    mode: NativeSetPositionMode,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSetPositionModeAction(mode),
      opts,
    );
  }

  /// Submit an SE-0 spot CLOB order via `POST /exchange`.
  ///
  /// v0 is IOC-limit only: `tif` defaults to `"ioc"` and `limit_px` must be
  /// `> 0` (the builder + node both enforce it). Sender-authorized: the signer
  /// is the trader, so there is no `owner` field and no local owner check.
  async submitSpotOrderNative(
    order: NativeSpotOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeSpotOrderAction(order), opts);
  }

  /// Cancel a resting SE-0 spot order via `POST /exchange`.
  ///
  /// Cancels by `(pair, oid)`; the node cancels spot orders by `oid`. Sender-
  /// authorized, same envelope as the other native actions.
  async cancelSpotOrderNative(
    cancel: NativeSpotCancel,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeSpotCancelAction(cancel), opts);
  }

  // ── spot margin & Earn actions (devnet preview) ───────────────────────────
  //
  // Leveraged spot borrows quote from the Earn lending pool. All SENDER-
  // AUTHORIZED (the signer is the actor). Each returns the 202 admission ack,
  // NOT a synchronous oid; observe committed state via `/info` `spot_margin_state`
  // / `earn_state`. Preview: forced-liquidation settlement is not yet wired and
  // per-pair maintenance ratios are still being calibrated.

  /// Post quote collateral into a spot-margin account via `POST /exchange`.
  /// Margin must be enabled for the pair (else the node rejects).
  async spotMarginDeposit(
    params: NativeSpotMarginDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSpotMarginDepositAction(params),
      opts,
    );
  }

  /// Withdraw free collateral from a spot-margin account via `POST /exchange`.
  /// Full while flat; initial-margin-gated while a position is open.
  async spotMarginWithdraw(
    params: NativeSpotMarginWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSpotMarginWithdrawAction(params),
      opts,
    );
  }

  /// Open a leveraged spot position via `POST /exchange`: borrow quote from the
  /// pair's Earn pool and IOC-buy base. Gated by the initial-margin requirement.
  async spotMarginOpen(
    params: NativeSpotMarginOpen,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSpotMarginOpenAction(params),
      opts,
    );
  }

  /// Close a leveraged spot position via `POST /exchange`: IOC-sell the held
  /// base, repay principal + interest, return the remainder (partial keeps open).
  async spotMarginClose(
    params: NativeSpotMarginClose,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSpotMarginCloseAction(params),
      opts,
    );
  }

  /// Supply quote into an Earn lending pool for shares via `POST /exchange`.
  /// 1:1 on a fresh pool, else priced off NAV; the pool auto-creates.
  async earnDeposit(
    params: NativeEarnDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeEarnDepositAction(params), opts);
  }

  /// Redeem Earn pool shares back to quote via `POST /exchange`. The payout is
  /// clamped to the pool's idle liquidity (`supplied − borrowed`).
  async earnWithdraw(
    params: NativeEarnWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeEarnWithdrawAction(params),
      opts,
    );
  }

  // ── order management ──────────────────────────────

  /// Cancel a resting order by its client order id via `POST /exchange`.
  async cancelByCloid(
    params: CancelByCloid,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeCancelByCloidAction(params), opts);
  }

  /// Amend a resting order's price and/or size in place via `POST /exchange`.
  async modify(
    params: Modify,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeModifyAction(params), opts);
  }

  /// Apply N modifications under one signature via `POST /exchange`.
  async batchModify(
    params: BatchModify,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeBatchModifyAction(params), opts);
  }

  /// Place N orders under one signature via `POST /exchange`. Each order's
  /// `owner` must equal the signing wallet; the batch returns the admission
  /// envelope (not per-order statuses).
  async batchOrder(
    batch: BatchOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postBatchOwnerChecked(
      buildNativeBatchOrderAction(batch),
      batch.orders.map((o) => o.owner),
      opts,
    );
  }

  /// Apply N cancels under one signature via `POST /exchange`. Each cancel's
  /// `owner` must equal the signing wallet.
  async batchCancel(
    batch: BatchCancel,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postBatchOwnerChecked(
      buildNativeBatchCancelAction(batch),
      batch.cancels.map((c) => c.owner),
      opts,
    );
  }

  /// Schedule a cancel-all of the sender's open orders at a future block.
  async scheduleCancel(
    params: ScheduleCancel,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeScheduleCancelAction(params), opts);
  }

  /// Cancel all of the sender's open orders (optionally one asset) via
  /// `POST /exchange`.
  async cancelAllOrders(
    params: CancelAllOrders = {},
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeCancelAllOrdersAction(params), opts);
  }

  // ── TWAP ──────────────────────────────────────

  /// Submit a sliced (TWAP) order via `POST /exchange`.
  async twapOrder(
    params: TwapOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeTwapOrderAction(params), opts);
  }

  /// Cancel a running TWAP parent by id via `POST /exchange`.
  async twapCancel(
    params: TwapCancel,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeTwapCancelAction(params), opts);
  }

  // ── leverage & margin ──────────────────────────

  /// Set per-asset leverage (and optionally flip to isolated) via `POST /exchange`.
  async updateLeverage(
    params: UpdateLeverage,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeUpdateLeverageAction(params), opts);
  }

  /// Add or remove isolated margin on an open position via `POST /exchange`.
  async updateIsolatedMargin(
    params: UpdateIsolatedMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeUpdateIsolatedMarginAction(params),
      opts,
    );
  }

  /// Top up the margin of a strict-isolated-only position via `POST /exchange`.
  async topUpIsolatedOnlyMargin(
    params: TopUpIsolatedOnlyMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeTopUpIsolatedOnlyMarginAction(params),
      opts,
    );
  }

  /// Enroll into or out of portfolio margin via `POST /exchange`.
  async userPortfolioMargin(
    params: UserPortfolioMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeUserPortfolioMarginAction(params),
      opts,
    );
  }

  // ── account & agent settings ───────────────────

  /// Set the account display name via `POST /exchange`.
  async setDisplayName(
    params: SetDisplayName,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeSetDisplayNameAction(params), opts);
  }

  /// Set the account referrer (one-time) via `POST /exchange`.
  async setReferrer(
    params: SetReferrer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeSetReferrerAction(params), opts);
  }

  /// Approve an agent wallet to sign on this account's behalf via `POST /exchange`.
  async approveAgent(
    params: ApproveAgent,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeApproveAgentAction(params), opts);
  }

  /// Approve a builder fee ceiling (`max_bps`; `0` revokes) via `POST /exchange`.
  async approveBuilderFee(
    params: ApproveBuilderFee,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeApproveBuilderFeeAction(params),
      opts,
    );
  }

  /// Convert the account to an M-of-N multisig via `POST /exchange`.
  async convertToMultiSigUser(
    params: ConvertToMultiSigUser,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeConvertToMultiSigUserAction(params),
      opts,
    );
  }

  /// Toggle the account's DEX-abstraction opt-in flag via `POST /exchange`.
  async userDexAbstraction(
    params: UserDexAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeUserDexAbstractionAction(params),
      opts,
    );
  }

  /// Set a self-scoped abstraction config value via `POST /exchange`.
  async userSetAbstraction(
    params: UserSetAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeUserSetAbstractionAction(params),
      opts,
    );
  }

  /// As an approved agent, set an abstraction config value for `params.user`
  /// via `POST /exchange`.
  async agentSetAbstraction(
    params: AgentSetAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeAgentSetAbstractionAction(params),
      opts,
    );
  }

  /// Pay a priority fee (bps) for block-front placement via `POST /exchange`.
  async priorityBid(
    params: PriorityBid,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativePriorityBidAction(params), opts);
  }

  // ── staking ──────────────────────────────────

  /// Delegate stake to a validator, or queue an undelegation, via `POST /exchange`.
  async tokenDelegate(
    params: TokenDelegate,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeTokenDelegateAction(params), opts);
  }

  /// Claim accrued staking rewards via `POST /exchange`.
  async claimRewards(
    params: ClaimRewards = {},
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeClaimRewardsAction(params), opts);
  }

  /// Alias another account as this account's staking target via `POST /exchange`.
  async linkStakingUser(
    params: LinkStakingUser,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeLinkStakingUserAction(params), opts);
  }

  // ── encrypted orders ───────────────────────────

  /// Submit a threshold-encrypted order ciphertext via `POST /exchange`.
  async submitEncryptedOrder(
    params: SubmitEncryptedOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSubmitEncryptedOrderAction(params),
      opts,
    );
  }

  // ── vaults ───────────────────────────────────

  /// Create a new vault via `POST /exchange`. The signing wallet becomes the
  /// leader. SENDER-AUTHORIZED.
  async createVault(
    params: CreateVault,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeCreateVaultAction(params), opts);
  }

  /// Leader moves capital into / out of a vault via `POST /exchange`.
  async vaultTransfer(
    params: VaultTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeVaultTransferAction(params), opts);
  }

  /// Leader updates vault configuration via `POST /exchange`.
  async vaultModify(
    params: VaultModify,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeVaultModifyAction(params), opts);
  }

  /// Follower redeems shares from a vault via `POST /exchange`. SENDER-AUTHORIZED.
  async vaultWithdraw(
    params: VaultWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeVaultWithdrawAction(params), opts);
  }

  // ── MetaBridge ───────────────────────────────

  /// Withdraw cross-collateral to a destination chain via `POST /exchange`.
  async mbWithdraw(
    params: MbWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(buildNativeMbWithdrawAction(params), opts);
  }

  // ── governance / operator ─────────────────────

  /// Set a metaliquidity-provider whitelist membership (validator-authorized)
  /// via `POST /exchange`.
  async setMetaliquidityWhitelist(
    params: SetMetaliquidityWhitelist,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeSetMetaliquidityWhitelistAction(params),
      opts,
    );
  }

  /// Register or revoke an external strategy operator for a vault
  /// (vault-leader-authorized) via `POST /exchange`.
  async registerMetaliquidityOperator(
    params: RegisterMetaliquidityOperator,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.postSenderAuthorized(
      buildNativeRegisterMetaliquidityOperatorAction(params),
      opts,
    );
  }

  /// Sign a pre-built sender-authorized action JSON and POST it to `/exchange`.
  ///
  /// Shared by the actions where the recovered signer IS the actor (no `owner`
  /// to cross-check): `set_position_mode`, `spot_order`, `spot_cancel`. Mirrors
  /// `submitOrderNative`'s flow minus the owner-vs-signer guard.
  private async postSenderAuthorized(
    actionJson: string,
    opts: { nonce?: bigint; chainId?: number },
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'this action requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const signed = await signNativeAction(
      this.privateKey,
      actionJson,
      nonce,
      opts.chainId,
    );
    return httpRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: nativeRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Sign a pre-built batch action whose inner orders / cancels each carry an
  /// `owner`, and POST it to `/exchange`. Recovers the signer once and rejects
  /// unless EVERY inner `owner` equals it (the node sets the sender to the
  /// recovered signer for all of them).
  private async postBatchOwnerChecked(
    actionJson: string,
    owners: string[],
    opts: { nonce?: bigint; chainId?: number },
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'this action requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const signed = await signNativeAction(
      this.privateKey,
      actionJson,
      nonce,
      opts.chainId,
    );
    const signer = await recoverNativeSigner(signed, opts.chainId);
    for (const owner of owners) {
      if (signer.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`batch item owner ${owner} != recovered signer ${signer}`);
      }
    }
    return httpRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: nativeRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Open an MTF-native WebSocket connection to `<baseUrl>/ws`.
  ///
  /// Derives the `ws(s)://` URL from the client's `http(s)://` base, mounts the
  /// `/ws` path (the node's upgrade route), and returns a connected
  /// [`WsClient`]. Register handlers via `ws.onMessage` and subscribe with
  /// `ws.subscribe({ type: 'l2_book', coin: 'BTC' })`.
  async connectWs(config: Partial<WsConfig> = {}): Promise<WsClient> {
    const ws = new WsClient(httpToWsUrl(this.baseUrl), config);
    await ws.connect();
    return ws;
  }

  /// `fetchMarkets` — list of all CCXT-compat market descriptors.
  /// Unauthenticated.
  async getMarkets(): Promise<Market[]> {
    return httpRequest<Market[]>(this.baseUrl, '/ccxt/markets');
  }

  /// `fetchPositions` for a given account. Authenticated. The CCXT
  /// surface defines `fetchPositions(symbols?)`; the MTF gateway
  /// adapter accepts an explicit `account` query parameter so the
  /// caller can fetch positions for sub-accounts they control.
  async getPositions(account: string): Promise<Position[]> {
    if (!isHexAddress(account)) {
      throw new RangeError(
        `getPositions: account must be a 0x-prefixed 20-byte hex string, got '${account}'`,
      );
    }
    return httpRequest<Position[]>(this.baseUrl, '/ccxt/positions', {
      query: { account },
      bearer: this.jwt,
    });
  }

  /// Internal: set the JWT after a successful `/auth` exchange. Exposed
  /// so an external auth flow (wallet popup, etc.) can plant a token.
  setJwt(token: string): void {
    this.jwt = token;
  }
}

// ============================================================================
// Encoding helpers — narrow + private
// ============================================================================

/// Encode a `Uint8Array` as a base64url string (no padding).
///
/// Matches the encoding the gateway's `LoginEnvelope.signature` field
/// expects. We
/// avoid Buffer/global polyfills here because the SDK targets both
/// node and the browser; manual base64 is small and avoids the
/// dependency.
function bytesToBase64Url(bytes: Uint8Array): string {
  // Build a binary string of the bytes. `String.fromCharCode` is
  // bounded to ~65k arguments per call — safe for any signature
  // (65 bytes) or payload (under 1KB).
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/// Encode a `Uint8Array` as a hex string with optional `0x` prefix.
function bytesToHex(bytes: Uint8Array, prefix: string = ''): string {
  let out = prefix;
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/// Derive the WS endpoint URL from the client's HTTP base URL: map the scheme
/// (`http`→`ws`, `https`→`wss`), strip any trailing slash, and append `/ws`
/// (the node's upgrade route). A base that is already `ws(s)://` is passed
/// through (only the `/ws` suffix is ensured).
function httpToWsUrl(baseUrl: string): string {
  let url = baseUrl;
  if (url.startsWith('https://')) {
    url = `wss://${url.slice('https://'.length)}`;
  } else if (url.startsWith('http://')) {
    url = `ws://${url.slice('http://'.length)}`;
  }
  if (url.endsWith('/')) url = url.slice(0, -1);
  return url.endsWith('/ws') ? url : `${url}/ws`;
}

/// Validate that a string is a `0x` + 40 hex chars EVM address.
function isHexAddress(s: string): boolean {
  if (s.length !== 42) return false;
  if (!s.startsWith('0x')) return false;
  for (let i = 2; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHex =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x46) ||
      (c >= 0x61 && c <= 0x66);
    if (!isHex) return false;
  }
  return true;
}
