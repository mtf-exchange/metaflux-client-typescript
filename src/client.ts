// `Client` — primary entry point for the @metaflux-dex/client SDK.
//
// Heavy lifting: order signing (msgpack encode -> EIP-712 hash ->
// secp256k1 sign -> address derive) runs through WASM. Pure-TS
// responsibilities: HTTP plumbing, type coercion, optional JWT
// session bookkeeping.
//
// Naming note: exported as `Client` (NOT `MtfClient`) per session
// direction. Consumers import as `import { Client } from '@metaflux-dex/client'`.

import { envelopeRequest, MetaFluxApiError } from './rest/http.js';
import {
  // Only the canonical action-JSON builders the TYPED order path still needs
  // (order / cancel / spot / TWAP / batch / scale / chase). Every other action
  // is signed via the typed registry (`submitTyped`), so its opaque builder is
  // no longer imported here (still exported for power users from `./native`).
  buildNativeBatchCancelAction,
  buildNativeBatchModifyAction,
  buildNativeBatchOrderAction,
  buildNativeCancelAction,
  buildNativeCancelByCloidAction,
  buildNativeCancelChaseAction,
  buildNativeCancelScaleAction,
  buildNativeChaseOrderAction,
  buildNativeModifyAction,
  buildNativeOrderAction,
  buildNativeScaleOrderAction,
  buildNativeScheduleCancelAction,
  buildNativeSpotCancelAction,
  buildNativeSpotOrderAction,
  buildNativeTwapCancelAction,
  buildNativeTwapOrderAction,
} from './native/actions.js';
import { nextNonce } from './native/digest.js';
import { PlaceOrderPartialError, planPlaceOrder } from './native/place.js';
import {
  buildTyped,
  signTypedAction,
  typedDataV4,
  typedRequestBody,
  type TypedDataV4,
  type TypedSignedAction,
} from './native/typed.js';
import {
  recoverTypedOrderSigner,
  signTypedOrder,
  typedOrderRequestBody,
  type TypedOrderPayload,
} from './native/typed_orders.js';
import { InfoApi } from './rest/info.js';
import { WsClient, type WsConfig } from './ws/ws.js';
import type {
  AgentSetAbstraction,
  ApproveAgent,
  ApproveBrokerFee,
  ApproveBuilderFee,
  BatchCancel,
  BatchModify,
  BatchOrder,
  CancelAllOrders,
  CancelByCloid,
  CancelChase,
  CancelScale,
  ChaseOrder,
  BorrowLend,
  CDeposit,
  ClaimRewards,
  ConvertToMultiSigUser,
  CoreEvmTransfer,
  CreateSubAccount,
  CreateVault,
  CWithdraw,
  FbaSubmit,
  LinkStakingUser,
  BridgeWithdraw,
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
  PlaceOrderLeg,
  PlaceOrderOpts,
  PlaceOrderResult,
  PlacedLeg,
  SpotPlaceResult,
  SpotSubmission,
  PriorityBid,
  PerpActivateMarket,
  PerpDeactivateMarket,
  Mip3SetOraclePx,
  PerpRegisterAsset,
  PerpSetFeeTier,
  PerpSetLeverage,
  PerpSetMakerRebate,
  PerpSetMinSize,
  PerpSetOracle,
  PerpSetSubDeployers,
  PerpSetSubDeployerPerms,
  RegisterMetaliquidityOperator,
  RfqAccept,
  RfqQuote,
  RfqRequest,
  SpotFinalizeSupply,
  SpotRegisterPair,
  SpotRegisterToken,
  SpotSeedHolders,
  SpotSetPairActive,
  SpotSetPairParams,
  ScaleOrder,
  ScheduleCancel,
  SendAsset,
  SendToEvmWithData,
  SetDisplayName,
  SetReferrer,
  SubAccountSpotTransfer,
  SubAccountTransfer,
  UsdClassTransfer,
  Withdraw,
  SubmitEncryptedOrder,
  TokenDelegate,
  TopUpIsolatedOnlyMargin,
  TwapCancel,
  TwapOrder,
  UpdateIsolatedMargin,
  UpdateLeverage,
  UserPortfolioMargin,
  UserSetAbstraction,
  VaultDistribute,
  VaultModify,
  VaultTransfer,
  VaultWithdraw,
} from './types/index.js';

/// Options accepted by the `Client` constructor.
export interface ClientOpts {
  /// Gateway base URL — e.g. `https://api.metaflux.example`. The Client posts
  /// MTF-native routes under this root: `/exchange` (signed writes), `/info`
  /// (reads, via `client.info`), and `/ws` (the WebSocket feed).
  baseUrl: string;
  /// Optional 32-byte ECDSA private key. Required for any signing operation
  /// (every `/exchange` write); read-only `/info` reads (via `client.info`)
  /// work without it.
  privateKey?: Uint8Array;
  /// LEGACY EVM chain id, retained for backward compatibility of the
  /// constructor. It is NOT used by any signing path today — the typed
  /// `/exchange` scheme signs against the MTF-native chain id (`MTF_CHAIN_ID`,
  /// testnet 114514), overridable per call via `opts.chainId`.
  chainId?: number;
  /// OPTIONAL default action-expiry (unix-ms) folded into every typed action
  /// this client signs. `0n` / absent = never expires (byte-identical to the
  /// pre-existing digest + wire body). When non-zero, the expiry is signed +
  /// tamper-evident and the node drops the action once its clock passes it.
  /// AVAILABILITY: a non-zero value is only accepted from the scheduled network
  /// upgrade onward — leave it unset until then. Per-call overrides are possible
  /// via the typed-order paths.
  expiresAfterMs?: bigint;
}

/// Per-call options for the trading actions. `nonce` / `chainId` bind the
/// signed digest. Every action signs the EIP-712 typed scheme — the node is
/// typed-only (the old opaque `MetaFluxAction` scheme is gone).
export interface TradeOpts {
  /// Per-account replay nonce. Defaults to a strictly-increasing unix-ms clock.
  nonce?: bigint;
  /// EIP-712 domain chain id. Defaults to `MTF_CHAIN_ID` (testnet 114514).
  chainId?: number;
}

/// Legacy default chain id for the (retired) `ClientOpts.chainId` field. No
/// signing path reads it; the typed `/exchange` scheme signs against
/// `MTF_CHAIN_ID`. Kept only so the constructor stays backward-compatible.
const DEFAULT_CHAIN_ID = 31337;

/// The `0x0` 20-byte address sentinel. `claim_rewards` uses it for "claim across
/// every validator" (the node's `address(0)` claim-all sentinel).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/// Primary client surface. Construct once per session.
///
/// Read-only example:
/// ```ts
/// const c = new Client({ baseUrl: 'http://localhost:8080' });
/// const markets = await c.info.markets();
/// ```
///
/// Signing example:
/// ```ts
/// const c = new Client({
///   baseUrl: 'http://localhost:8080',
///   privateKey: hexToBytes('...'),
/// });
/// const ack = await c.submitOrderNative({
///   owner: '0x…', market: 1, side: 'bid', kind: 'limit',
///   size: 1000, limit_px: 5_000_000_000_000, tif: 'gtc',
///   stp_mode: 'cancel_newest', reduce_only: false,
/// });
/// ```
export class Client {
  private readonly baseUrl: string;
  private readonly privateKey: Uint8Array | undefined;
  private readonly chainId: number;
  /// Default action-expiry (unix-ms) folded into every typed action signed by
  /// this client. `0n` = never expires (byte-identical to the no-expiry form).
  private readonly expiresAfterMs: bigint;
  /// Cached gateway-issued JWT (`/auth`). The session is established
  /// lazily on the first authenticated call.
  private jwt: string | undefined;
  /// Confirmed agent approvals, keyed `${owner}:${signer}` in lower case.
  private readonly agentApprovals = new Set<string>();
  /// MTF-native read API (`POST /info`). Read-only; no key required.
  readonly info: InfoApi;

  constructor(opts: ClientOpts) {
    if (opts.baseUrl.length === 0) {
      throw new RangeError('Client baseUrl must be non-empty');
    }
    if (opts.privateKey !== undefined && opts.privateKey.length !== 32) {
      throw new RangeError('Client privateKey must be exactly 32 bytes');
    }
    if (opts.expiresAfterMs !== undefined) {
      if (opts.expiresAfterMs < 0n || opts.expiresAfterMs >= 1n << 64n) {
        throw new RangeError('Client expiresAfterMs must be a u64');
      }
    }
    this.baseUrl = opts.baseUrl;
    this.privateKey = opts.privateKey;
    this.chainId = opts.chainId ?? DEFAULT_CHAIN_ID;
    this.expiresAfterMs = opts.expiresAfterMs ?? 0n;
    this.info = new InfoApi(this.baseUrl);
  }

  /// Whether this client has a private key available for signing
  /// operations. Read-only data calls work regardless.
  get canSign(): boolean {
    return this.privateKey !== undefined;
  }

  /// Submit an order via the MTF-native signed-action front door
  /// (`POST /exchange`), signed under the typed (EIP-712) scheme.
  ///
  /// Flow:
  /// 1. `buildNativeOrderAction` produces the canonical snake_case action JSON
  ///    string (`{"type":"submit_order","order":{...}}`), field order matching
  ///    the server `NativeOrder`.
  /// 2. The typed digest is computed over the EIP-712 `SubmitOrder` struct (the
  ///    node reconstructs it from the parsed `action` fields) and signed.
  /// 3. The action string is POSTed inside `{action, nonce, signature}`.
  ///
  /// `order.owner` names the account the order rests under. The signing wallet
  /// must be that account OR one of its approved agents — the same rule the node
  /// applies. The client recovers the signer, reads the owner's approved agents
  /// from `/info`, and rejects an unrelated address before hitting the network.
  ///
  /// `nonce` is the per-owner replay nonce bound into the digest. Defaults to
  /// `Date.now()` (unix-ms) — supply an explicit monotonically-increasing
  /// value for back-to-back submissions in the same millisecond.
  ///
  /// `chainId` defaults to the MTF-native chain id (`MTF_CHAIN_ID` = testnet
  /// 114514; mainnet is 8964).
  async submitOrderNative(
    order: NativeOrder,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    const actionJson = buildNativeOrderAction(order);
    return this.postTypedOrderAuthorized(
      'submit_order',
      { order },
      actionJson,
      order.owner,
      [],
      opts,
    );
  }

  /// Cancel an order via the MTF-native signed-action front door
  /// (`POST /exchange`), signed under the typed (EIP-712) scheme.
  ///
  /// Same envelope + verification model as `submitOrderNative`: the
  /// `cancel_order` action JSON is built canonically, signed over the typed
  /// digest, and POSTed. The server cancels by `oid`, so `cancel.oid` must be
  /// set — the typed digest binds `oid`, so a cloid-only cancel has no typed
  /// form and throws (the node is typed-only; there is no opaque fallback).
  ///
  /// `cancel.owner` names the account whose order is cancelled. The signing
  /// wallet must be that account OR one of its approved agents — the same rule
  /// the node applies.
  async cancelOrderNative(
    cancel: NativeCancel,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    const actionJson = buildNativeCancelAction(cancel);
    return this.postTypedOrderAuthorized(
      'cancel_order',
      { cancel },
      actionJson,
      cancel.owner,
      [],
      opts,
    );
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
    return this.submitTyped(
      'set_position_mode',
      mode as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Submit an SE-0 spot CLOB order via `POST /exchange`.
  ///
  /// `tif` defaults to `"ioc"`; `gtc` and `alo` rest the residual with escrow.
  /// With `order.owner` set, the signing key must be an APPROVED AGENT of that
  /// owner and the node routes the order under the owner. Absent, the signer
  /// trades for itself. Either way the signer is not cross-checked locally — an
  /// agent key is not the owner.
  async submitSpotOrderNative(
    order: NativeSpotOrder,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'spot_order',
      { order },
      buildNativeSpotOrderAction(order),
      opts,
    );
  }

  /// Cancel a resting SE-0 spot order via `POST /exchange`.
  ///
  /// Cancels by `(pair, oid)`; the node cancels spot orders by `oid`. With
  /// `cancel.owner` set, the signing key must be an APPROVED AGENT of that owner
  /// and the node cancels the owner's order. Absent, the signer cancels its own.
  async cancelSpotOrderNative(
    cancel: NativeSpotCancel,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'spot_cancel',
      { cancel },
      buildNativeSpotCancelAction(cancel),
      opts,
    );
  }

  // ── spot margin & Earn actions (devnet preview) ───────────────────────────
  //
  // Leveraged spot borrows quote from the Earn lending pool. All SENDER-
  // AUTHORIZED (the signer is the actor). Each returns the 202 admission ack,
  // NOT a synchronous oid; observe committed state via `/info` `spot_margin_state`
  // / `earn_state`. Forced-liquidation settlement IS wired and runs every block.
  // What is still pending is governance, not code: no spot pair has its per-pair
  // risk parameters calibrated yet, so opening rejects until a vote lands.

  /**
   * Post quote collateral into a spot-margin account via `POST /exchange`.
   *
   * @deprecated DEAD SURFACE. The node REJECTS `spot_margin_deposit` while
   * cross-margin is active, which on the live chain is from genesis
   * ("spot-margin is cross-collateralized against your USDC account; no separate
   * deposit"). Collateral is the ONE unified USDC account, so there is no
   * per-pair bucket to fund. Fund the account instead — a MetaBridge deposit —
   * then call `spotMarginOpen` / `spotMarginClose`, which draw on it. The action
   * stays on the wire only so old signatures stay verifiable.
   */
  async spotMarginDeposit(
    params: NativeSpotMarginDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.spotMarginDepositTyped(params, opts);
  }

  /**
   * Withdraw free collateral from a spot-margin account via `POST /exchange`.
   *
   * @deprecated DEAD SURFACE. The node REJECTS `spot_margin_withdraw` while
   * cross-margin is active, which on the live chain is from genesis
   * ("spot-margin is cross-collateralized; withdraw USDC from your account
   * directly"). Collateral is the ONE unified USDC account, so there is no
   * per-pair bucket to drain. Withdraw account-wide with `mbWithdraw` instead.
   * The action stays on the wire only so old signatures stay verifiable.
   */
  async spotMarginWithdraw(
    params: NativeSpotMarginWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.spotMarginWithdrawTyped(params, opts);
  }

  /// Open a leveraged spot position via `POST /exchange`: borrow quote from the
  /// pair's Earn pool and IOC-buy base. Gated by the initial-margin requirement.
  async spotMarginOpen(
    params: NativeSpotMarginOpen,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.spotMarginOpenTyped(params, opts);
  }

  /// Close a leveraged spot position via `POST /exchange`: IOC-sell the held
  /// base, repay principal + interest, return the remainder (partial keeps open).
  async spotMarginClose(
    params: NativeSpotMarginClose,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_margin_close',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Supply quote into an Earn lending pool for shares via `POST /exchange`.
  /// 1:1 on a fresh pool, else priced off NAV; the pool auto-creates.
  async earnDeposit(
    params: NativeEarnDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.earnDepositTyped(params, opts);
  }

  /// Redeem Earn pool shares back to quote via `POST /exchange`. The payout is
  /// clamped to the pool's idle liquidity (`supplied − borrowed`).
  async earnWithdraw(
    params: NativeEarnWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.earnWithdrawTyped(params, opts);
  }

  // ── order management ──────────────────────────────

  /// Cancel a resting order by its client order id via `POST /exchange`.
  async cancelByCloid(
    params: CancelByCloid,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'cancel_by_cloid',
      { params },
      buildNativeCancelByCloidAction(params),
      opts,
    );
  }

  /// Amend a resting order's price and/or size in place via `POST /exchange`.
  async modify(
    params: Modify,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'modify',
      { params },
      buildNativeModifyAction(params),
      opts,
    );
  }

  /// Apply N modifications under one signature via `POST /exchange`.
  async batchModify(
    params: BatchModify,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'batch_modify',
      { params },
      buildNativeBatchModifyAction(params),
      opts,
    );
  }

  /// Place N orders under one signature via `POST /exchange`. The node returns
  /// one `statuses` entry PER PLACED LEG, each echoing that leg's own `cloid`.
  ///
  /// One batch acts for ONE account: `batch.owner`, or the signing wallet when
  /// `batch.owner` is absent. Set `batch.owner` to trade as an approved agent of
  /// another account. Every leg's `owner` must name that same account.
  async batchOrder(
    batch: BatchOrder,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    const actionJson = buildNativeBatchOrderAction(batch);
    return this.postTypedOrderAuthorized(
      'batch_order',
      { params: batch },
      actionJson,
      batch.owner,
      batch.orders.map((o) => o.owner),
      opts,
    );
  }

  /// Place one order or many through ONE entry point via `POST /exchange`.
  ///
  /// Tag each order with its `venue` and this method picks the wire action:
  /// - `venue: "perp"`, ANY count → one `batch_order`. The node answers with one
  ///   status per placed leg, so a single order and a batch read the same way.
  ///   `opts.grouping` rides this route only.
  /// - `venue: "spot"` → one `spot_order` PER order. `batch_order` legs are perp
  ///   `NativeOrder`s, so the wire cannot batch spot.
  ///
  /// `opts.owner` rides BOTH routes — an approved agent places AS that owner.
  /// - MIXED perp and spot → REJECTED. Two venues have no single wire action,
  ///   and a silent split would give the caller two independent submissions
  ///   where they expect one.
  ///
  /// The result narrows on `route`. The spot route returns N `submissions` for
  /// N independent actions — it is NOT one submission, so read every entry. A
  /// spot action that fails stops the run and throws
  /// [`PlaceOrderPartialError`], which carries the same per-action record.
  ///
  /// Every existing method still reaches its wire action directly. This one adds
  /// no plane conversion: `limit_px` stays in the 1e8 book plane and `size`
  /// stays in raw lots. Use [`planPlaceOrder`] to read the action bytes first.
  async placeOrder(
    orders: PlaceOrderLeg | readonly PlaceOrderLeg[],
    opts: PlaceOrderOpts = {},
  ): Promise<PlaceOrderResult> {
    const plan = planPlaceOrder(orders, opts);
    const tradeOpts: TradeOpts = { nonce: opts.nonce, chainId: opts.chainId };

    if (plan.route === 'batch_order') {
      const ack = await this.batchOrder(plan.batch, tradeOpts);
      const legs: PlacedLeg[] = plan.batch.orders.map((order, index) => ({
        index,
        cloid: order.cloid,
        status: ack.statuses?.[index],
      }));
      return { route: 'batch_order', ack, legs };
    }

    const submissions: SpotSubmission[] = plan.orders.map((order, index) => ({
      index,
      cloid: order.cloid,
      state: 'not_sent',
    }));
    const result: SpotPlaceResult = { route: 'spot_order', submissions };
    for (const [index, order] of plan.orders.entries()) {
      try {
        const ack = await this.submitSpotOrderNative(order, tradeOpts);
        submissions[index] = { index, cloid: order.cloid, state: 'sent', ack };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const api = err instanceof MetaFluxApiError ? err : undefined;
        submissions[index] = {
          index,
          cloid: order.cloid,
          state: 'failed',
          error: reason,
          code: api?.code,
          details: api?.details,
        };
        throw new PlaceOrderPartialError(result, reason);
      }
    }
    return result;
  }

  /// Apply N cancels under one signature via `POST /exchange`.
  ///
  /// One batch acts for ONE account: `batch.owner`, or the signing wallet when
  /// `batch.owner` is absent. Set `batch.owner` to cancel as an approved agent of
  /// another account. Every cancel's `owner` must name that same account.
  async batchCancel(
    batch: BatchCancel,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    const actionJson = buildNativeBatchCancelAction(batch);
    return this.postTypedOrderAuthorized(
      'batch_cancel',
      { params: batch },
      actionJson,
      batch.owner,
      batch.cancels.map((c) => c.owner),
      opts,
    );
  }

  /// Place a SCALE ladder (`scale_order`, action 213) via `POST /exchange`. One
  /// signed COMPACT ladder the node expands into `n` resting limit rungs that
  /// all share `params.cloid`; use [`cancelScale`] to sweep the group.
  /// SENDER-AUTHORIZED (the digest binds the optional agent-resolved
  /// `params.owner` when present — the signer is then the approved agent, so no
  /// owner cross-check). Availability is gated: the node rejects the action
  /// until the `scale_order` feature is armed. `params.market` is a PERP market
  /// today — see [`ScaleOrder`] for the spot lane that is not live yet.
  async placeScale(
    params: ScaleOrder,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'scale_order',
      { params },
      buildNativeScaleOrderAction(params),
      opts,
    );
  }

  /// Cancel a SCALE ladder group (`cancel_scale`, action 214) via
  /// `POST /exchange` — sweeps every resting rung on `params.market` owned by
  /// the sender that carries `params.cloid`. SENDER-AUTHORIZED (binds the
  /// optional agent-resolved `params.owner` when present).
  async cancelScale(
    params: CancelScale,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'cancel_scale',
      { params },
      buildNativeCancelScaleAction(params),
      opts,
    );
  }

  /// Place a CHASE order (`chase_order`, action 211) via `POST /exchange`. One
  /// signed compact intent: the node places one resting Leg and re-prices it
  /// toward the touch every `params.interval_blocks` committed heights, until the
  /// fill completes, `params.ttl_ms` elapses, or `params.max_reprices` is reached.
  /// Every Reprice re-stamps `params.cloid`. There is no chase-specific read/WS
  /// channel: track the Leg on `open_orders` / `order_updates` by `cloid`, and
  /// keep the `chase_oid` from the ack (`statuses[0].chase.chase_oid`) for
  /// [`cancelChase`]. SENDER-AUTHORIZED (the digest binds the optional
  /// agent-resolved `params.owner` when present). `params.market` is a PERP
  /// market today — see [`ChaseOrder`] for the spot lane that is not live yet.
  async placeChase(
    params: ChaseOrder,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'chase_order',
      { params },
      buildNativeChaseOrderAction(params),
      opts,
    );
  }

  /// Cancel a running CHASE (`cancel_chase`, action 212) via `POST /exchange` —
  /// cancels its resting Leg and retires its registry entry. `params.chase_oid`
  /// is the handle from the placement ack (the registry key), NOT the Leg's oid.
  /// SENDER-AUTHORIZED (binds the optional agent-resolved `params.owner` when
  /// present).
  async cancelChase(
    params: CancelChase,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'cancel_chase',
      { params },
      buildNativeCancelChaseAction(params),
      opts,
    );
  }

  /// Schedule a cancel-all of the sender's open orders at a future block.
  async scheduleCancel(
    params: ScheduleCancel,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'schedule_cancel',
      { params },
      buildNativeScheduleCancelAction(params),
      opts,
    );
  }

  /// Cancel all of the sender's open orders (optionally one asset) via
  /// `POST /exchange`, signed under the typed scheme. Delegates to
  /// `cancelAllOrdersTyped`; pass `opts.owner` there to cancel another account's
  /// orders as its approved agent (the owner-carrying digest).
  async cancelAllOrders(
    params: CancelAllOrders = {},
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.cancelAllOrdersTyped(params, opts);
  }

  // ── TWAP ──────────────────────────────────────

  /// Submit a sliced (TWAP) order via `POST /exchange`. `params.market` is a
  /// PERP market today — see [`TwapOrder`] for the spot lane that is not live
  /// yet. A HEDGE account is refused at commit unless the parent carries
  /// `position_side`.
  async twapOrder(
    params: TwapOrder,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'twap_order',
      { params },
      buildNativeTwapOrderAction(params),
      opts,
    );
  }

  /// Cancel a running TWAP parent by id via `POST /exchange`.
  async twapCancel(
    params: TwapCancel,
    opts: TradeOpts = {},
  ): Promise<NativeExchangeAck> {
    return this.postTradeAction(
      'twap_cancel',
      { params },
      buildNativeTwapCancelAction(params),
      opts,
    );
  }

  // ── leverage & margin ──────────────────────────

  /// Set per-asset leverage (and optionally flip to isolated) via `POST /exchange`.
  async updateLeverage(
    params: UpdateLeverage,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'update_leverage',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Add or remove isolated margin on an open position via `POST /exchange`.
  async updateIsolatedMargin(
    params: UpdateIsolatedMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.updateIsolatedMarginTyped(params, opts);
  }

  /// Top up the margin of a strict-isolated-only position via `POST /exchange`.
  async topUpIsolatedOnlyMargin(
    params: TopUpIsolatedOnlyMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.topUpIsolatedOnlyMarginTyped(params, opts);
  }

  /// Enroll into or out of portfolio margin via `POST /exchange`.
  async userPortfolioMargin(
    params: UserPortfolioMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'user_portfolio_margin',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Enroll the signing account into portfolio margin via `POST /exchange`.
  ///
  /// Convenience wrapper over `userPortfolioMargin({ enroll: true })`. The node's
  /// `pm_enroll` action tag is an unmapped stub, so this deliberately emits the
  /// bridged `user_portfolio_margin` action (NOT a `pm_enroll` tag).
  async pmEnroll(
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.userPortfolioMargin({ enroll: true }, opts);
  }

  /// Unenroll the signing account from portfolio margin via `POST /exchange`.
  ///
  /// Signs the W1 `pm_unenroll` typed alias — a paramless `{"type":"pm_unenroll"}`
  /// envelope whose EIP-712 digest is exactly the `UserPortfolioMargin{enroll:
  /// false}` struct (same primary type, `enroll` forced `false`). Routes through
  /// the typed `/exchange` path, NOT the legacy opaque `user_portfolio_margin`.
  async pmUnenroll(
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped('pm_unenroll', {}, opts);
  }

  // ── account & agent settings ───────────────────

  /// Set the account display name via `POST /exchange`.
  async setDisplayName(
    params: SetDisplayName,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'set_display_name',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Set the account referrer (one-time) via `POST /exchange`.
  async setReferrer(
    params: SetReferrer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'set_referrer',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Approve an agent wallet to sign on this account's behalf via `POST /exchange`.
  /// `name` / `expires_at_ms` default to `""` / `0` (never expires) when omitted
  /// — matching the node's typed digest, which always binds both fields.
  async approveAgent(
    params: ApproveAgent,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'approve_agent',
      {
        agent: params.agent,
        name: params.name ?? '',
        expires_at_ms: params.expires_at_ms ?? 0,
      },
      opts,
    );
  }

  /// Approve a broker fee ceiling (`max_bps`; `0` revokes) via `POST /exchange`.
  ///
  /// The POSTed tag is `approve_broker_fee`. The EIP-712 type string stays
  /// `ApproveBuilderFee`, which is consensus-frozen, so the two names differ on
  /// purpose.
  async approveBrokerFee(
    params: ApproveBrokerFee,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'approve_broker_fee',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Old name for `approveBrokerFee`.
  async approveBuilderFee(
    params: ApproveBuilderFee,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.approveBrokerFee(params, opts);
  }

  /// Convert the account to an M-of-N multisig via `POST /exchange`.
  async convertToMultiSigUser(
    params: ConvertToMultiSigUser,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'convert_to_multi_sig_user',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Submit a multi-sig acting WRAPPER via `POST /exchange`.
  ///
  /// The roster members first each sign the inner action off-band (see
  /// [`signMultiSigInner`] in `./native/multisig.js`) over the SAME canonical
  /// `inner_action_blob` bytes and the SAME `innerNonce`; collect
  /// `threshold`-many distinct signatures. This method packages them into the
  /// `{"type":"multi_sig",...}` wrapper and signs the OUTER envelope with this
  /// client's key (the wrapper may be submitted by ANY account — its authority is
  /// the recovered inner-signer set, not this outer signer).
  ///
  /// The envelope `nonce` is PINNED to `innerNonce` (NOT a fresh clock value): it
  /// must equal the nonce the roster signed, and it advances against the acting
  /// `user`'s nonce window.
  ///
  /// @param user             the acting multisig account (0x-hex address)
  /// @param innerActionBlobHex the exact canonical inner action bytes as 0x-hex
  /// @param signatures       the collected roster signatures (0x-hex 65-byte each)
  /// @param innerNonce       the nonce the roster signed (== envelope nonce)
  async multiSig(
    user: string,
    innerActionBlobHex: string,
    signatures: readonly string[],
    innerNonce: bigint,
    opts: { chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'multiSig requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    // Pin the envelope nonce to the inner nonce the roster signed — do NOT
    // allocate a fresh one. The wrapper's `expires_after` stays absent (the inner
    // action's own semantics govern; the outer envelope is a pass-through).
    const signed = await signTypedAction(
      this.privateKey,
      'multi_sig',
      {
        user,
        inner_action_blob: innerActionBlobHex,
        signatures: [...signatures],
      },
      innerNonce,
      opts.chainId,
    );
    return this.postTyped(signed);
  }

  /// Set a self-scoped abstraction config value via `POST /exchange`.
  async userSetAbstraction(
    params: UserSetAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.userSetAbstractionTyped(params, opts);
  }

  /// As an approved agent, set an abstraction config value for `params.user`
  /// via `POST /exchange`.
  async agentSetAbstraction(
    params: AgentSetAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.agentSetAbstractionTyped(params, opts);
  }

  /// Pay a priority fee (bps) for block-front placement via `POST /exchange`.
  async priorityBid(
    params: PriorityBid,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.priorityBidTyped(params, opts);
  }

  // ── staking ──────────────────────────────────

  /// Delegate stake to a validator, or queue an undelegation, via `POST /exchange`.
  async tokenDelegate(
    params: TokenDelegate,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.tokenDelegateTyped(params, opts);
  }

  /// Claim accrued staking rewards via `POST /exchange`. Omit `params.validator`
  /// (or pass the zero address) to claim across every validator (`address(0)` =
  /// claim-all, the node sentinel — always bound into the typed digest).
  async claimRewards(
    params: ClaimRewards = {},
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'claim_rewards',
      { validator: params.validator ?? ZERO_ADDRESS },
      opts,
    );
  }

  /// Drain the sender's accrued broker-code fee credit into spendable
  /// cross-collateral via `POST /exchange`. No params. SENDER-AUTHORIZED.
  ///
  /// The POSTed tag is `claim_broker_rewards`. The EIP-712 type string stays
  /// `ClaimBuilderRewards`: it is consensus-frozen, so the two names differ on
  /// purpose. The claim reports no amount — read `builder_state` first.
  async claimBrokerRewards(
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped('claim_broker_rewards', {}, opts);
  }

  /// Old name for `claimBrokerRewards`.
  async claimBuilderRewards(
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.claimBrokerRewards(opts);
  }

  /// Drain the sender's accrued referrer fee credit into spendable
  /// cross-collateral via `POST /exchange` (`claim_referral_rewards`, typed
  /// scheme). No params. SENDER-AUTHORIZED.
  async claimReferralRewards(
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped('claim_referral_rewards', {}, opts);
  }

  /// Alias another account as this account's staking target via `POST /exchange`.
  async linkStakingUser(
    params: LinkStakingUser,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'link_staking_user',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── encrypted orders ───────────────────────────

  /// Submit a threshold-encrypted order ciphertext via `POST /exchange`.
  async submitEncryptedOrder(
    params: SubmitEncryptedOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitEncryptedOrderTyped(params, opts);
  }

  // ── vaults ───────────────────────────────────

  /// Create a new vault via `POST /exchange`. The signing wallet becomes the
  /// leader. SENDER-AUTHORIZED.
  async createVault(
    params: CreateVault,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'create_vault',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Leader moves capital into / out of a vault via `POST /exchange`.
  async vaultTransfer(
    params: VaultTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.vaultTransferTyped(params, opts);
  }

  /// Leader updates vault configuration via `POST /exchange`. Only the vault
  /// NAME is signed / applied (the node's typed `vault_modify` binds `new_name`
  /// alone); an omitted `new_name` signs the empty-string sentinel (no rename).
  async vaultModify(
    params: VaultModify,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'vault_modify',
      { vault_id: params.vault_id, new_name: params.new_name ?? '' },
      opts,
    );
  }

  /// Follower redeems shares from a vault via `POST /exchange`. SENDER-AUTHORIZED.
  async vaultWithdraw(
    params: VaultWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.vaultWithdrawTyped(params, opts);
  }

  /// Follower deposits USD into a vault, minting shares at the current NAV, via
  /// `POST /exchange` (`vault_distribute`). The deposit rides the `pnl` field
  /// (legacy node name) as a positive decimal string. SENDER-AUTHORIZED.
  async vaultDistribute(
    params: VaultDistribute,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'vault_distribute',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── MetaBridge ───────────────────────────────

  /// Withdraw cross-collateral to a destination chain via `POST /exchange`.
  async mbWithdraw(
    params: BridgeWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.mbWithdrawTyped(params, opts);
  }

  // ── RFQ / FBA microstructure (W1 typed path) ──────────────────────────────
  //
  // These sign the node's frozen `RfqRequest` / `RfqAccept` / `FbaSubmit`
  // EIP-712 typed structs and POST the canonical `{"type":...,"params":{...}}`
  // envelope the typed-only `/exchange` admits — routed through `submitTyped`,
  // the SAME path as the generic typed actions (the convenience signature only
  // pins the action tag + param type). Numeric fields are RAW `u64` wire values;
  // `side` POSTs the core PascalCase name and signs the uint8 code; `limit_px` /
  // `stp_group` are optional (omit when absent).
  //
  // All three RFQ methods take `opts.owner` to act AS a vault; `fbaSubmit` is
  // sender-authorized.

  /// **RFQ IS THE OPTION TRADE PATH.** All three methods clear OPTION series
  /// and nothing else. A market that is not a LIVE series is rejected with
  /// `rfq is options-only: market <n> is not an option series`. A
  /// request-for-quote lane beside a public order book lets size trade away
  /// from the price everyone else posts against, so MetaFlux offers RFQ only
  /// where there is no continuous book to undercut. Options have none.
  ///
  /// `market` takes the `signing_id` of a live series, from
  /// `InfoApi.optionSeries`. Serve that number; never derive it.
  ///
  /// An accept moves the premium from the buyer to the writer and locks the
  /// writer's escrow. It opens no perpetual position and reserves no margin.
  /// The escrow funds the payoff in full at the fill, so an option position can
  /// never be liquidated. Only the TAKER pays a fee, and only when governance
  /// has set an option fee schedule; both terms start unset and charge nothing.
  ///
  /// THE PREMIUM IS USDC ON BOTH KINDS. THE ESCROW IS NOT. A put writer locks
  /// the strike in USDC out of cross collateral. A CALL WRITER LOCKS ONE COIN
  /// of the underlying per unit, out of its SPOT balance, and the USDC premium
  /// it receives cannot net that lock. Read `settle_asset` on the series row
  /// before you fund a write; a writer short of the coin is refused with
  /// `insufficient underlying balance for the escrow`.
  ///
  /// The session reads are public and typed: `InfoApi.rfqUser` gives a taker
  /// its own `rfq_id`, and `InfoApi.rfqOpen` gives a maker the open requests. A
  /// quote's INDEX in `RfqSession.quotes` is the `quote_idx` an accept names. No
  /// WS channel carries an RFQ event, so both are polled.
  ///
  /// TO ACT AS A VAULT, PASS `opts.owner` ON BOTH LEGS. The owner is bound into
  /// the RFQ digests, so an approved agent must sign which account requests and
  /// accepts. Omit it and the node admits the action for the SIGNER's own
  /// account — the escrow and the option position land on the operator wallet.

  /// Open an RFQ session as a taker (`rfq_request`, typed scheme). Pass
  /// `opts.owner` to request AS a vault (operator path) — it binds the node's
  /// owner-carrying `RfqRequest` digest and rides in `params.owner`.
  async rfqRequest(
    params: RfqRequest,
    opts: { nonce?: bigint; chainId?: number; owner?: string } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'rfq_request',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Post a maker quote onto an open RFQ session (`rfq_quote`, typed scheme).
  /// Numeric fields are RAW `u64` wire values; `stp_group` is optional (omit when
  /// absent). Pass `opts.owner` to quote AS a vault (operator path) — it binds the
  /// node's owner-carrying `RfqQuote` digest and rides in `params.owner`.
  async rfqQuote(
    params: RfqQuote,
    opts: { nonce?: bigint; chainId?: number; owner?: string } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'rfq_quote',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Cross against a specific resting RFQ quote (`rfq_accept`, typed scheme).
  /// `quote_idx` is the quote's index in `RfqSession.quotes`; re-read the
  /// session first, because an expired quote shifts every later index.
  ///
  /// Pass the SAME `opts.owner` the request carried. The node gates the accept
  /// on `requester == sender`, so an accept signed without the owner is not the
  /// requester and is rejected.
  async rfqAccept(
    params: RfqAccept,
    opts: { nonce?: bigint; chainId?: number; owner?: string } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'rfq_accept',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Submit an order into a market's frequent-batch-auction pool (`fba_submit`,
  /// typed scheme). The price field is `price` (NOT `limit_px`); `side` is the
  /// core PascalCase name; `stp_group` is optional (omit when absent).
  async fbaSubmit(
    params: FbaSubmit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'fba_submit',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ============================================================================
  // Trading-set typed scheme (the typed `/exchange`) — order / cancel / TWAP /
  // batch actions. Every trading action signs the EIP-712 typed digest; the node
  // is typed-only (the opaque `MetaFluxAction` scheme is gone).
  // ============================================================================

  /// Sign a trading action under the typed (EIP-712) scheme and POST it with
  /// the typed `/exchange`. `actionJson` is the canonical action bytes (built by
  /// the `./native/actions.js` builders); `payload` carries the order / cancel /
  /// params body the typed digest is computed over. SENDER-AUTHORIZED (no owner
  /// cross-check); use [`postTypedOrderAuthorized`] when the action names an owner.
  private async postTypedOrder(
    actionType: string,
    payload: TypedOrderPayload,
    actionJson: string,
    opts: TradeOpts,
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'this action requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const signed = await signTypedOrder(
      this.privateKey,
      actionType,
      payload,
      actionJson,
      nonce,
      opts.chainId,
      undefined,
      this.expiresAfterMs,
    );
    return envelopeRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: typedOrderRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Route a sender-authorized trading action through the typed scheme.
  /// `actionJson` is the canonical bytes; `actionType` + `payload` drive the
  /// typed digest.
  private async postTradeAction(
    actionType: string,
    payload: TypedOrderPayload,
    actionJson: string,
    opts: TradeOpts,
  ): Promise<NativeExchangeAck> {
    return this.postTypedOrder(actionType, payload, actionJson, opts);
  }

  /// Like [`postTypedOrder`] but authorizes the ACTING ACCOUNT before it POSTs.
  ///
  /// `actor` is the account the node routes the action under: the `owner` the
  /// action claims, or the signer when the action claims none. `legOwners` are
  /// the per-item `owner` fields of a batch, which the node IGNORES — it routes
  /// the whole batch under the one actor — so a leg that names another account
  /// is a caller mistake and throws here.
  private async postTypedOrderAuthorized(
    actionType: string,
    payload: TypedOrderPayload,
    actionJson: string,
    actor: string | undefined,
    legOwners: readonly string[],
    opts: TradeOpts,
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'this action requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const signed = await signTypedOrder(
      this.privateKey,
      actionType,
      payload,
      actionJson,
      nonce,
      opts.chainId,
      undefined,
      this.expiresAfterMs,
    );
    const signer = await recoverTypedOrderSigner(signed, actionType, payload, opts.chainId);
    const account = actor ?? signer;
    await this.assertMayActFor(signer, account);
    legOwners.forEach((legOwner, index) => {
      if (legOwner.toLowerCase() !== account.toLowerCase()) {
        throw new Error(
          `${actionType} item ${index} owner ${legOwner} is not the acting account ` +
            `${account}: the node routes every item of one batch under one account. ` +
            'Set the batch-level `owner` to act for another account.',
        );
      }
    });
    return envelopeRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: typedOrderRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Confirm the signer may act for `owner`, and throw a named error when it
  /// may not.
  ///
  /// The chain admits two signers for an owner-carrying action: the owner
  /// itself, and any agent the owner approved. This reads the SAME committed
  /// `agents` facet of `/info` `account_state` the node reads at admission,
  /// so the client is never stricter than the chain. A mistyped owner has not approved this
  /// signer, so it still throws here, before the action reaches the wire.
  ///
  /// Only a positive answer is cached: a stale negative would keep blocking an
  /// agent that the owner approved seconds ago. An unreachable `/info` does not
  /// block the action — the node re-runs the check and is the authority.
  private async assertMayActFor(signer: string, owner: string): Promise<void> {
    const signerKey = signer.toLowerCase();
    const ownerKey = owner.toLowerCase();
    if (signerKey === ownerKey) return;
    const pair = `${ownerKey}:${signerKey}`;
    if (this.agentApprovals.has(pair)) return;
    const approved = await this.info
      .accountOverview(owner)
      .then(({ agents }) =>
        agents.some((a) => a.agent.toLowerCase() === signerKey),
      )
      .catch(() => undefined);
    if (approved === false) {
      throw new Error(
        `signer ${signer} may not act for owner ${owner}: it is neither that ` +
          'account nor one of its approved agents. Check the owner address, or ' +
          'approve this key with approveAgent.',
      );
    }
    if (approved === true) this.agentApprovals.add(pair);
  }

  // ============================================================================
  // EIP-712 typed-action scheme (the typed `/exchange`).
  //
  // The wallet-signed actions below are sent as proper EIP-712 typed structs
  // so a wallet (`eth_signTypedData_v4`) renders the named fields. The POST body
  // carries the typed `/exchange` + the same canonical `action` JSON that was
  // hashed. Everything else keeps the legacy opaque scheme above.
  //
  // The chain id for these is the MTF-native chain id (`MTF_CHAIN_ID`, testnet
  // 114514 by default), NOT the legacy `ClientOpts.chainId` (a different domain).
  // ============================================================================

  /// Build the `eth_signTypedData_v4` payload for one of the typed actions,
  /// WITHOUT signing. Hand this (JSON-stringified) to a wallet's
  /// `eth_signTypedData_v4`; submit the returned 65-byte signature with
  /// [`postTyped`]. `payload` carries only the action-specific snake_case fields
  /// (no `metafluxChain` / `nonce`).
  typedData(
    actionType: string,
    payload: Record<string, unknown>,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): {
    payload: TypedDataV4;
    actionJson: string;
    nonce: bigint;
    expiresAfter: bigint;
  } {
    const nonce = opts.nonce ?? nextNonce();
    const built = buildTyped(
      actionType,
      payload,
      nonce,
      opts.chainId,
      undefined,
      this.expiresAfterMs,
    );
    // Echo `expiresAfter` so the caller can pass it back to [`postTyped`] in the
    // `TypedSignedAction` (the wire body carries `expires_after` only when set).
    return {
      payload: typedDataV4(built),
      actionJson: built.actionJson,
      nonce,
      expiresAfter: this.expiresAfterMs,
    };
  }

  /// POST an already-signed typed action (e.g. from a wallet's
  /// `eth_signTypedData_v4`) to `/exchange` under the typed `/exchange`. Pass the
  /// `{ actionJson, nonce }` from [`typedData`] plus the 0x-hex 65-byte signature.
  async postTyped(
    signed: TypedSignedAction,
  ): Promise<NativeExchangeAck> {
    return envelopeRequest<NativeExchangeAck>(this.baseUrl, '/exchange', {
      method: 'POST',
      rawJson: typedRequestBody(signed),
      bearer: this.jwt,
    });
  }

  /// Sign one of the typed actions with this client's private key (the local
  /// signing path — agents / tests) and POST it under the typed `/exchange`.
  /// `payload` carries only the action-specific snake_case fields.
  ///
  /// `opts.owner` binds an agent-resolved `owner` into the digest + POST `params`
  /// for an owner-supporting action (today only `cancel_all_orders`): the client's
  /// key signs the `*_WITH_OWNER` form (`address owner` at position 2) and the node
  /// acts on `owner`'s account — the approved-agent path where the signer is NOT
  /// the owner, so no signer==owner cross-check applies. Ignored (owner-less,
  /// byte-identical) for actions with no owner form.
  async submitTyped(
    actionType: string,
    payload: Record<string, unknown>,
    opts: { nonce?: bigint; chainId?: number; owner?: string } = {},
  ): Promise<NativeExchangeAck> {
    if (this.privateKey === undefined) {
      throw new Error(
        'submitTyped requires a privateKey in ClientOpts (this Client is read-only)',
      );
    }
    const nonce = opts.nonce ?? nextNonce();
    const signed = await signTypedAction(
      this.privateKey,
      actionType,
      payload,
      nonce,
      opts.chainId,
      opts.owner,
      this.expiresAfterMs,
    );
    return this.postTyped(signed);
  }

  // ── typed transfers (new under the typed scheme) ──────────────────────────

  /// Transfer an asset between dexes / accounts (`send_asset`, typed scheme).
  async sendAsset(
    params: SendAsset,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'send_asset',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move USD notional between the spot and perp classes (`usd_class_transfer`,
  /// typed scheme).
  async usdClassTransfer(
    params: UsdClassTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'usd_class_transfer',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Withdraw an asset to an external destination chain (`withdraw`, typed
  /// scheme).
  async withdraw(
    params: Withdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'withdraw',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── typed margin / staking / vault / spot-margin / earn / bridge ───────────
  //
  // These mirror the legacy-scheme methods of the same root name but sign under
  // the typed `/exchange`. They carry a `Typed` suffix so both schemes remain
  // reachable (decimal fields are canonical strings, hashed verbatim).

  /// Add or remove isolated margin (`update_isolated_margin`, typed scheme).
  async updateIsolatedMarginTyped(
    params: UpdateIsolatedMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'update_isolated_margin',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Top up a strict-isolated-only position (`top_up_isolated_only_margin`,
  /// typed scheme).
  async topUpIsolatedOnlyMarginTyped(
    params: TopUpIsolatedOnlyMargin,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'top_up_isolated_only_margin',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Delegate / undelegate stake to a validator (`token_delegate`, typed scheme).
  async tokenDelegateTyped(
    params: TokenDelegate,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'token_delegate',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Agent sets an abstraction config value for a user (`agent_set_abstraction`,
  /// typed scheme; `value` is an EIP-712 string signed verbatim).
  async agentSetAbstractionTyped(
    params: AgentSetAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'agent_set_abstraction',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Leader moves capital into / out of a vault (`vault_transfer`, typed scheme).
  async vaultTransferTyped(
    params: VaultTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'vault_transfer',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Follower redeems vault shares (`vault_withdraw`, typed scheme).
  async vaultWithdrawTyped(
    params: VaultWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'vault_withdraw',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Withdraw cross-collateral to a destination chain (`bridge_withdraw`, typed
  /// scheme). The POST `params.chain` carries the chain NAME; the signed struct
  /// field is its `uint8` code (Base=1, Arbitrum=2). `amount` is an
  /// integer (uint64), not a decimal string.
  async mbWithdrawTyped(
    params: BridgeWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'bridge_withdraw',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /**
   * Post quote collateral into a spot-margin account (`spot_margin_deposit`,
   * typed scheme).
   *
   * @deprecated DEAD SURFACE — see `spotMarginDeposit`. The node rejects this
   * action while cross-margin is active (live: from genesis). Fund the unified
   * USDC account instead, then call `spotMarginOpen`. Kept so an old signature
   * stays verifiable.
   */
  async spotMarginDepositTyped(
    params: NativeSpotMarginDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_margin_deposit',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /**
   * Withdraw free collateral from a spot-margin account
   * (`spot_margin_withdraw`, typed scheme).
   *
   * @deprecated DEAD SURFACE — see `spotMarginWithdraw`. The node rejects this
   * action while cross-margin is active (live: from genesis). Withdraw
   * account-wide with `mbWithdraw` instead. Kept so an old signature stays
   * verifiable.
   */
  async spotMarginWithdrawTyped(
    params: NativeSpotMarginWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_margin_withdraw',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Open a leveraged spot position (`spot_margin_open`, typed scheme).
  async spotMarginOpenTyped(
    params: NativeSpotMarginOpen,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_margin_open',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Supply quote into a lending pool for shares (`earn_deposit`, typed scheme).
  async earnDepositTyped(
    params: NativeEarnDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'earn_deposit',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Redeem lending-pool shares back to quote (`earn_withdraw`, typed scheme).
  async earnWithdrawTyped(
    params: NativeEarnWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'earn_withdraw',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move liquidity against the BOLE pool (`borrow_lend`, typed scheme).
  ///
  /// `kind` rides the wire as its PascalCase name and signs as a `uint8` code.
  /// `Borrow` is refused unless the sender is a registered liquidator.
  /// Sender-authorized.
  async borrowLend(
    params: BorrowLend,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'borrow_lend',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── metaliquidity vault leader ────────────────────────────────────────────

  /// Grant or revoke a Metaliquidity vault operator
  /// (`register_metaliquidity_operator`, typed scheme).
  ///
  /// The signer must be the vault's leader, and a grant also needs the operator
  /// to be a recognised MetaLiquidity Provider. Omit `expires_at_ms` for an
  /// operator that never expires — an explicit `0` is refused before signing,
  /// because the digest cannot tell it from an absent field.
  /// Sender-authorized.
  async registerMetaliquidityOperator(
    params: RegisterMetaliquidityOperator,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'register_metaliquidity_operator',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── SD-1 permissionless spot deployer lane (MIP-1) ────────────────────────
  //
  // All six are sender-authorized: the recovered signer IS the deployer. The
  // two register calls pay the Dutch-clock ask at commit, bounded by the signed
  // `max_deploy_fee`. Decimal fields ride the wire verbatim — pass the exact
  // string, never a `Number` round-trip.

  /// Register a spot token and pay the Dutch-clock ask (`spot_register_token`).
  async spotRegisterToken(
    params: SpotRegisterToken,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_register_token',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Register a `(base, quote)` trading pair (`spot_register_pair`).
  async spotRegisterPair(
    params: SpotRegisterPair,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_register_pair',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Set a pair's fee tier and min notional (`spot_set_pair_params`). Both fee
  /// legs are DECI-bps and must stay below `1000`.
  async spotSetPairParams(
    params: SpotSetPairParams,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_set_pair_params',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Open or close a pair to new orders (`spot_set_pair_active`).
  async spotSetPairActive(
    params: SpotSetPairActive,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_set_pair_active',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Stage genesis holder rows for a registered token (`spot_seed_holders`).
  ///
  /// Repeatable. `holders` and `amounts` are parallel and both are signed in
  /// order. Amounts are WHOLE units, never wei.
  async spotSeedHolders(
    params: SpotSeedHolders,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_seed_holders',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Check the staged rows, then mint once (`spot_finalize_supply`).
  /// `max_supply` must equal the sum of every staged row.
  async spotFinalizeSupply(
    params: SpotFinalizeSupply,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'spot_finalize_supply',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── MIP-3 permissionless perp deployer lane ───────────────────────────────
  //
  // All nine are sender-authorized: the recovered signer IS the deployer or one
  // of its sub-deployers. None carries a `bid` — the legacy gas-auction lane is
  // dead and the handler rejects a non-zero bid.
  //
  // NOT LIVE YET. The nine tags landed in the node but that binary is not
  // released, so the live chain refuses every one of them today. They start
  // working at the activation height of the release that carries them.

  /// Allocate a fresh MIP-3 perp market (`perp_register_asset`). The signer
  /// becomes its deployer. `decimals` of `0` reads as the handler default of 8.
  ///
  /// The first call by a deployer also creates its perp DEX, so `params.name`
  /// must be valid on it and `params.symbol` must carry that name as a prefix.
  async perpRegisterAsset(
    params: PerpRegisterAsset,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_register_asset',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Bind the market's enabled oracle-source subset (`perp_set_oracle`).
  ///
  /// @deprecated RETIRED. The node refuses this action from the release that
  /// lands per-handler sub-deployer permissions. Nothing replaces it; the
  /// deployer price control is `mip3SetOraclePx`.
  async perpSetOracle(
    params: PerpSetOracle,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_oracle',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Set the market's max leverage (`perp_set_leverage`), bounded `1`–`50`.
  async perpSetLeverage(
    params: PerpSetLeverage,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_leverage',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Set the three fee legs (`perp_set_fee_tier`). Each leg must stay below
  /// `1000`. The taker and maker legs are DECI-bps; the deployer leg is WHOLE
  /// bps. A governance ceiling also bounds the taker and maker legs.
  async perpSetFeeTier(
    params: PerpSetFeeTier,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_fee_tier',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Set the market's maker rebate (`perp_set_maker_rebate`), bounded `0`–`2`
  /// WHOLE bps.
  async perpSetMakerRebate(
    params: PerpSetMakerRebate,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_maker_rebate',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Set the market's min order size (`perp_set_min_size`), in the market's
  /// size plane.
  async perpSetMinSize(
    params: PerpSetMinSize,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_min_size',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Open the market to trading (`perp_activate_market`).
  async perpActivateMarket(
    params: PerpActivateMarket,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_activate_market',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Close the market to NEW orders (`perp_deactivate_market`).
  async perpDeactivateMarket(
    params: PerpDeactivateMarket,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_deactivate_market',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Add or remove ONE delegated deployer (`perp_set_sub_deployers`). Both the
  /// address and the add / remove flag are signed, so no relay can re-target
  /// the delegate or flip a removal into a grant.
  async perpSetSubDeployers(
    params: PerpSetSubDeployers,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_sub_deployers',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Grant ONE delegate an exact permission mask
  /// (`perp_set_sub_deployer_perms`). One bit is one deployer action, so a grant
  /// can hand out the price push without the fee rates. A grant REPLACES: send
  /// the full mask the delegate must end with; `0` revokes.
  ///
  /// Both the address and the mask are signed, so no relay can re-target the
  /// delegate or widen the mask.
  async perpSetSubDeployerPerms(
    params: PerpSetSubDeployerPerms,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'perp_set_sub_deployer_perms',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Push the market's index px from its deployer oracle
  /// (`mip3_set_oracle_px`).
  ///
  /// Gated by the `mip3_deployer_oracle` fork feature, which is ACTIVE FROM
  /// GENESIS on a fresh chain. A legacy or unknown network answers
  /// `mip3_deployer_oracle feature not active` until a stake vote arms it.
  ///
  /// `px` is a WHOLE-USDC decimal string, hashed verbatim: the exact bytes
  /// passed here are both signed and posted. Where the feature is active, the
  /// FIRST push force-migrates existing cross legs on the market to
  /// strict-isolated margin, and a stale feed turns the market reduce-only.
  async mip3SetOraclePx(
    params: Mip3SetOraclePx,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'mip3_set_oracle_px',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  // ── Core ↔ MetaFluxEVM transfer + sub-accounts + staking moves (typed) ─────
  //
  // These were previously un-mapped on the typed-only `/exchange` (so a typed
  // request was rejected); they now sign under the typed `/exchange`. The methods
  // already present on the legacy/native path (`cancelAllOrders`,
  // `userSetAbstraction`, `priorityBid`, `submitEncryptedOrder`) gain a `Typed`
  // suffix so both schemes stay reachable.

  /// Move a Core spot token to MetaFluxEVM (`core_evm_transfer`, typed scheme).
  /// Core → EVM only: debits the sender's Core balance for `asset` (omit / `0` =
  /// USDC cross-collateral; any other id = its spot balance, which must be linked
  /// to an EVM contract) and mints the scale-converted token to `destination` on
  /// the next EVM block. `asset` is part of the signed digest, so a relay can't
  /// redirect the transfer to a different token. `to_evm: false` (EVM → Core) is
  /// rejected by the node — that direction originates as an EVM burn tx.
  /// Sender-authorized.
  ///
  /// The move charges a fee in MTF, on top of `amount`, with a USDC fallback. The
  /// fee is ZERO today. It can be refused three ways, including one that does not
  /// depend on the token you move — see {@link CoreEvmTransfer}.
  async coreEvmTransfer(
    params: CoreEvmTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'core_evm_transfer',
      // `asset` is part of the signed digest; default to 0 (USDC) when omitted so
      // the uint32 field always has a value to encode.
      { ...params, asset: params.asset ?? 0 } as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move a Core spot token to MetaFluxEVM with an EVM payload
  /// (`send_to_evm_with_data`, typed scheme). Core → EVM only: it debits the
  /// sender's Core balance for `token`, mints the scale-converted token to
  /// `destination_recipient` on the next EVM block, then runs `data` against that
  /// address. Sender-authorized.
  ///
  /// `source_dex`, `to_perp` and `destination_chain_id` are signed slots the node
  /// REFUSES to bend: it rejects any value but `0`, `false` and a local delivery.
  /// They default here to the only accepted values, so an omitted field cannot
  /// produce a payload the node then rejects. `params.nonce` is the transfer tag,
  /// NOT the replay guard — pass `opts.nonce` to pick the envelope nonce.
  ///
  /// The move charges the SAME MTF fee as `coreEvmTransfer`, on top of `amount`,
  /// with a USDC fallback. The fee is ZERO today. It can be refused three ways,
  /// including one that does not depend on the token you move — see
  /// {@link SendToEvmWithData}.
  async sendToEvmWithData(
    params: SendToEvmWithData,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'send_to_evm_with_data',
      // The node's wire struct defaults NO key, so every field must reach the
      // POST params, present or defaulted.
      {
        ...params,
        source_dex: params.source_dex ?? 0,
        to_perp: params.to_perp ?? false,
        destination_chain_id: params.destination_chain_id ?? 0,
        nonce: params.nonce ?? 0,
      } as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Open a sub-account under the sender (`create_sub_account`, typed scheme).
  /// Omit `explicit_index` for the next available slot (it flattens to a presence
  /// flag + value in the signed digest; the POST omits it when absent).
  async createSubAccount(
    params: CreateSubAccount,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'create_sub_account',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move perp cross-collateral master ↔ sub-account (`sub_account_transfer`,
  /// typed scheme).
  async subAccountTransfer(
    params: SubAccountTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'sub_account_transfer',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move a spot token balance master ↔ sub-account
  /// (`sub_account_spot_transfer`, typed scheme).
  async subAccountSpotTransfer(
    params: SubAccountSpotTransfer,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'sub_account_spot_transfer',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move spot MTF into the free staking balance (`c_deposit`, typed scheme).
  async cDeposit(
    params: CDeposit,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'c_deposit',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Move the free staking balance back to spot MTF (`c_withdraw`, typed scheme).
  async cWithdraw(
    params: CWithdraw,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'c_withdraw',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Self-scope an abstraction config value (`user_set_abstraction`, typed
  /// scheme; `value` is an EIP-712 string signed verbatim).
  async userSetAbstractionTyped(
    params: UserSetAbstraction,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'user_set_abstraction',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Pay a priority fee (bps) for block-front placement (`priority_bid`, typed
  /// scheme).
  async priorityBidTyped(
    params: PriorityBid,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'priority_bid',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Cancel all the sender's open orders, optionally one asset
  /// (`cancel_all_orders`, typed scheme). Omit `asset` to cancel across all
  /// assets (it flattens to a presence flag + value in the signed digest; the
  /// POST omits it when absent).
  ///
  /// Pass `opts.owner` to act as an approved AGENT of another account: the
  /// client's key signs the owner-carrying digest (`address owner` at position 2,
  /// selecting the node's `CANCEL_ALL_ORDERS_WITH_OWNER` form) and the POST
  /// `params` carries `owner` (0x-hex), so the node cancels `owner`'s orders. Omit
  /// it to cancel the signer's own orders (owner-less digest, byte-identical).
  async cancelAllOrdersTyped(
    params: CancelAllOrders = {},
    opts: { nonce?: bigint; chainId?: number; owner?: string } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'cancel_all_orders',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Submit a threshold-encrypted order ciphertext (`submit_encrypted_order`,
  /// typed scheme). `ciphertext` signs as EIP-712 `bytes` (`keccak256(raw)`),
  /// `commitment` as a `bytes32`; both POST as JSON byte arrays.
  async submitEncryptedOrderTyped(
    params: SubmitEncryptedOrder,
    opts: { nonce?: bigint; chainId?: number } = {},
  ): Promise<NativeExchangeAck> {
    return this.submitTyped(
      'submit_encrypted_order',
      params as unknown as Record<string, unknown>,
      opts,
    );
  }

  /// Open an MTF-native WebSocket connection to `<baseUrl>/ws`.
  ///
  /// Derives the `ws(s)://` URL from the client's `http(s)://` base, mounts the
  /// `/ws` path (the node's upgrade route), and returns a connected
  /// [`WsClient`]. Register handlers via `ws.onMessage` and subscribe with
  /// `ws.subscribe({ type: 'l2_book', coin: '1' })`.
  ///
  /// If this client holds a private key, the returned `WsClient` is seeded with
  /// a signer so it can POST signed typed exchange actions over the socket
  /// (`ws.submitOrder` / `ws.cancelOrder` / `ws.postAction`) — signed against
  /// the MTF-native chain id (`MTF_CHAIN_ID`), the same typed digest the REST
  /// `/exchange` path uses. A read-only client yields a WS client that can still
  /// subscribe and `postInfo`, but not `postAction`.
  async connectWs(config: Partial<WsConfig> = {}): Promise<WsClient> {
    const signer =
      this.privateKey !== undefined ? { privateKey: this.privateKey } : undefined;
    const ws = new WsClient(httpToWsUrl(this.baseUrl), config, signer);
    await ws.connect();
    return ws;
  }

  // NOTE: The CCXT market / position reads (`getMarkets` / `getPositions`, which
  // hit the deleted `/ccxt/*` routes — ADR-028) were REMOVED. Use the MTF-native
  // `/info` reads instead: `client.info.markets()` for the market universe,
  // `client.info.accountState(address)` for the account summary and balances,
  // and `client.info.clearinghouseState(address)` for the position rows.

  /// Internal: set the JWT after a successful `/auth` exchange. Exposed
  /// so an external auth flow (wallet popup, etc.) can plant a token.
  setJwt(token: string): void {
    this.jwt = token;
  }
}

// ============================================================================
// Encoding helpers — narrow + private
// ============================================================================

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
