// Public barrel — every export consumers see goes through this file.
//
// Pinning the public surface here means we can refactor the internal
// `client.ts` / `wallet/wasm.ts` / `rest/http.ts` split without touching
// anything import-facing. The npm package `exports` map points at the compiled
// `dist/index.js`, so consumers write:
//
//     import { Client, type Order } from '@metaflux-dex/client';

export { Client, type ClientOpts, type TradeOpts } from './client.js';
export { MetaFluxApiError } from './rest/http.js';
export { sharesToWire } from './types/vault.js';
export {
  // Unified order placement — plan a request onto the wire without signing it,
  // and the error the spot route throws when it stops part-way.
  planPlaceOrder,
  PlaceOrderPartialError,
} from './native/place.js';
export { requestFaucet, type FaucetResponse } from './faucet.js';
export {
  // MTF-native signed-action signing core. Exported so power users can build /
  // sign / inspect actions out-of-band.
  MTF_CHAIN_ID,
  MTF_MAINNET_CHAIN_ID,
  MTF_TESTNET_CHAIN_ID,
  nativeActionDigest,
  signNativeAction,
  recoverNativeSigner,
  nativeRequestBody,
  // u64 wire-value normalization (price/size fields accept number|bigint|string).
  toU64,
  type U64Input,
} from './native/digest.js';
export {
  // Decimal <-> 1e8/sz_decimals wire-scale conversions. Turn a human decimal
  // price/size into the order REQUEST wire's fixed-point u64 — losslessly, no
  // floating point. The wire->decimal inverses are for request-plane display
  // only; `/info` and WS responses are ALREADY canonical decimal strings.
  PX_DECIMALS,
  pxToWire,
  wireToPx,
  szToWire,
  wireToSz,
  decimalToScaled,
  scaledToDecimal,
  // Round-to-grid: snap a human px/size to the market tick / lot before
  // building an order (the node REJECTS off-grid px/size). Opt-in.
  snapPxToWire,
  snapSizeToWire,
  roundOrderToGrid,
  type MarketGrid,
  type SnappedOrder,
} from './native/scale.js';
export {
  // TWAP planning: "sell this much, over this long" -> the wire fields
  // `slice_count` / `delay_ms` / `total_size`. The wire carries neither a
  // duration nor a USD amount, so the derivation is client-side. The node
  // clamps `delay_ms` UP to a governed floor SILENTLY, which makes the run
  // longer than the requested duration — the plan reports the real run time in
  // `effectiveDurationMs` and the clamp in `clampedToMinDelay`.
  twapFromDuration,
  usdToWireSize,
  DEFAULT_TWAP_MIN_DELAY_MS,
  DEFAULT_TWAP_TARGET_SLICE_MS,
  DEFAULT_TWAP_MAX_SLICES,
  type TwapDurationRequest,
  type TwapPlan,
} from './native/twap_plan.js';
export {
  // EIP-712 typed-action signing (the structured wallet-signing path). Exported
  // so wallet integrations can build the `eth_signTypedData_v4` payload and sign
  // out-of-band, and power users can sign with a local key directly.
  TYPED_ACTION_TYPES,
  isTypedAction,
  encodeType,
  primaryType,
  metafluxChainTag,
  buildTyped,
  typedActionDigest,
  typedDataV4,
  signTypedAction,
  recoverTypedSigner,
  typedRequestBody,
  foldExpiryTypeString,
  type TypedDataV4,
  type TypedSignedAction,
} from './native/typed.js';
export {
  // Multi-sig inner-signature signing (roster member prehash). User-bound is the
  // default scheme (in force after the scheduled network upgrade); `legacy` is
  // the pre-upgrade opt-in.
  MULTI_SIG_INNER_TYPE,
  MULTI_SIG_INNER_LEGACY_TYPE,
  multiSigInnerDigest,
  multiSigInnerDigestLegacy,
  signMultiSigInner,
  recoverMultiSigInner,
  type MultiSigInnerScheme,
} from './native/multisig.js';
export {
  // EIP-712 typed signing for the trading set (orders / cancels / TWAP /
  // batches). Exported so power users can build / sign / inspect trading actions
  // out-of-band under the typed scheme.
  TYPED_ORDER_ACTION_TYPES,
  isTypedOrderAction,
  encodeOrderType,
  buildTypedOrder,
  typedOrderDigest,
  signTypedOrder,
  recoverTypedOrderSigner,
  typedOrderRequestBody,
  type BuiltTypedOrder,
  type TypedOrderPayload,
} from './native/typed_orders.js';
export {
  // MTF-native action builders — the full real /exchange surface.
  buildNativeOrderAction,
  buildNativeCancelAction,
  buildNativeCancelByCloidAction,
  buildNativeModifyAction,
  buildNativeBatchModifyAction,
  buildNativeBatchOrderAction,
  buildNativeBatchCancelAction,
  buildNativeScaleOrderAction,
  buildNativeCancelScaleAction,
  buildNativeChaseOrderAction,
  buildNativeCancelChaseAction,
  buildTpSlLimitOrder,
  buildNativeScheduleCancelAction,
  buildNativeCancelAllOrdersAction,
  buildNativeSetPositionModeAction,
  buildNativeTwapOrderAction,
  buildNativeTwapCancelAction,
  buildNativeUpdateLeverageAction,
  buildNativeUpdateIsolatedMarginAction,
  buildNativeTopUpIsolatedOnlyMarginAction,
  buildNativeUserPortfolioMarginAction,
  buildNativeSetDisplayNameAction,
  buildNativeSetReferrerAction,
  buildNativeApproveAgentAction,
  buildNativeApproveBrokerFeeAction,
  buildNativeApproveBuilderFeeAction,
  buildNativeConvertToMultiSigUserAction,
  buildNativeUserSetAbstractionAction,
  buildNativeAgentSetAbstractionAction,
  buildNativePriorityBidAction,
  buildNativeTokenDelegateAction,
  buildNativeClaimRewardsAction,
  buildNativeLinkStakingUserAction,
  buildNativeSubmitEncryptedOrderAction,
  buildNativeCreateVaultAction,
  buildNativeVaultTransferAction,
  buildNativeVaultModifyAction,
  buildNativeVaultWithdrawAction,
  buildNativeVaultDistributeAction,
  buildNativeMbWithdrawAction,
  // RFQ / FBA / encrypted-order are signed via the W1 typed path
  // (`Client.rfqRequest` / `rfqAccept` / `fbaSubmit` / `submitEncryptedOrder` →
  // `submitTyped`), not opaque action builders.
  // Spot CLOB + spot margin (leveraged spot) + Earn (lending pool).
  buildNativeSpotOrderAction,
  buildNativeSpotCancelAction,
  buildNativeSpotMarginDepositAction,
  buildNativeSpotMarginWithdrawAction,
  buildNativeSpotMarginOpenAction,
  buildNativeSpotMarginCloseAction,
  buildNativeEarnDepositAction,
  buildNativeEarnWithdrawAction,
} from './native/actions.js';
export {
  // MTF-native `/info` read API.
  InfoApi,
} from './rest/info.js';
export type {
  // MTF-native `/info` response shapes. Source of truth:
  // the KB spec `metaflux-knowledges/api/rest/info.md`. Every field is the exact
  // snake_case key the node emits inside the `{type, data}` envelope's `data`.
  NodeInfo,
  AccountState,
  AccountPosition,
  DexPositions,
  TokenBalance,
  Tier,
  MarginMode,
  Abstraction,
  MarketInfo,
  MarketStatic,
  MarketDynamic,
  MarketKind,
  MarginTier,
  TokenEvmContract,
  PerpUnderlyingToken,
  Funding,
  VaultState,
  StakingState,
  Delegation,
  PendingUnstake,
  AssetAmount,
  AssetSignedSum,
  ProtocolMetricsEvm,
  ProtocolMetrics,
  FeeSchedule,
  FeeTier,
  TradeSide,
  OrderTif,
  OrderTrigger,
  OpenOrders,
  OpenOrder,
  L2Book,
  L2BookParams,
  L2Level,
  RecentTrades,
  TradesByTime,
  TradeRecord,
  UserFills,
  UserFillsByTime,
  UserPositionHistory,
  PositionHistoryRow,
  UserFill,
  FundingHistory,
  FundingSample,
  PredictedFunding,
  Candle,
  CandleType,
  CandleSnapshot,
  BlockInfo,
  Agents,
  AgentEntry,
  SubAccounts,
  SubAccountEntry,
  Mip3ActiveBids,
  Mip3Bid,
  // P2 wave-1 typed /info reads.
  OrderStatusInfo,
  RestingOrderStatus,
  TriggerOrderStatus,
  HistoricalOrders,
  HistoricalOrder,
  UserFunding,
  UserFundingRecord,
  UserLedgerUpdates,
  UserNonFundingLedgerUpdates,
  LedgerUpdate,
  SpotMarginState,
  SpotMarginAccount,
  SpotMarginParams,
  EarnState,
  EarnPool,
  PmSummary,
  EncodeAction,
  // Node-snapshot parity shapes.
  Markets,
  MarketsMeta,
  SpotMeta,
  SpotPair,
  SpotToken,
  SpotClearinghouseState,
  SpotBalance,
  ExchangeStatus,
  Liquidatable,
  LiquidatableAccount,
  ActiveAssetData,
  MaxMarketOrderNtls,
  MaxMarketOrderNtl,
  VaultSummaries,
  VaultSummary,
  UserVaultEquities,
  VaultEquity,
  LeadingVaults,
  UserRateLimit,
  SpotDeployState,
  DelegatorSummary,
  MaxBuilderFee,
  UserToMultiSigSigners,
  UserRole,
  PerpsAtOpenInterestCap,
  ValidatorL1Votes,
  ValidatorL1Vote,
  PerpDexs,
  PerpDex,
  ValidatorSummaries,
  ValidatorSummary,
  GossipRootIps,
  // The consolidated `web_data` account snapshot.
  WebData,
  WebDataStaking,
  WebDataVault,
} from './types/info/index.js';
export {
  // MTF-native WebSocket client + subscription/channel types.
  WsClient,
  WS_CHANNELS,
  isChannelFrame,
  type WsChannel,
  type WsSubscription,
  type WsFrame,
  type WsChannelData,
  type WsChannelFrame,
  type WsMessageHandler,
  type WsConfig,
  type WsSigner,
  type AllMids,
  type ActiveAssetCtx,
  type ActiveAssetCtxBody,
  type ActiveAssetDataFrame,
  type WsTrade,
  type WsFill,
  type WsOpenOrder,
  type WsOrderUpdate,
  type WsOrderUpdateOrder,
  type WsUserFunding,
  type ExplorerBlock,
  type ExplorerTx,
  // Per-channel WS body types.
  type WsL2Level,
  type WsL2Book,
  type WsBbo,
  type WsCandleFrame,
  type WsNodeCandle,
  type WsUserEvent,
  type WsNotification,
  type WsNotificationKind,
  type WsLedgerUpdate,
  type WsLedgerUpdateKind,
  type WsTwapSliceFill,
  type WsTwapHistoryRecord,
  type WsTwapHistoryState,
  type WsMarketRow,
  type WsAccountState,
  type WsWebData,
  type WsSpotMarginState,
} from './ws/ws.js';
export {
  WasmNotBuiltError,
  WasmCallError,
  // Low-level crypto wrappers — exported so power users can build
  // their own signing flows (e.g. transferring sign() out of the
  // browser to a hardware-backed signer).
  keccak256,
  signSecp256k1,
  recoverPubkey,
  eip712TypedDataHash,
  encodeLimitOrder,
  deriveAddressFromPubkey,
} from './wallet/wasm.js';
export type {
  Order,
  Builder,
  SignedOrder,
  OrderAck,
  Market,
  Position,
  Side,
  Tif,
  ErrorEnvelope,
  // MTF-native action types.
  NativeOrder,
  NativeCancel,
  NativeBuilder,
  NativeTrigger,
  NativeTpSl,
  NativeSide,
  NativePositionSide,
  NativeOrderKind,
  NativeTif,
  NativeStpMode,
  NativeSetPositionMode,
  NativeSpotOrder,
  NativeSpotCancel,
  NativeSpotMarginDeposit,
  NativeSpotMarginWithdraw,
  NativeSpotMarginOpen,
  NativeSpotMarginClose,
  NativeEarnDeposit,
  NativeEarnWithdraw,
  NativeSignedAction,
  NativeExchangeAck,
  // BOLE lend / borrow + the SD-1 spot-deployer lane (MIP-1) + the
  // metaliquidity vault leader's operator grant.
  BorrowLendKind,
  BorrowLend,
  SpotRegisterToken,
  SpotRegisterPair,
  SpotSetPairParams,
  SpotSetPairActive,
  SpotSeedHolders,
  SpotFinalizeSupply,
  RegisterMetaliquidityOperator,
  // MIP-3 permissionless perp-deployer lane. Landed in the node, NOT yet
  // released: the live chain refuses all nine tags until the swap height.
  PerpRegisterAsset,
  PerpSetOracle,
  PerpSetLeverage,
  PerpSetFeeTier,
  PerpSetMakerRebate,
  PerpSetMinSize,
  PerpActivateMarket,
  PerpDeactivateMarket,
  PerpSetSubDeployers,
  // Unified placement (one entry point over the order wire actions).
  PerpOrderLeg,
  SpotOrderLeg,
  PlaceOrderLeg,
  PlaceOrderOpts,
  BatchOrderPlan,
  SpotOrderPlan,
  PlaceOrderPlan,
  PlacedLeg,
  BatchPlaceResult,
  SpotSubmissionBase,
  SpotSubmission,
  SpotPlaceResult,
  PlaceOrderResult,
  // Order-management actions.
  OrderGrouping,
  Modify,
  BatchModify,
  BatchOrder,
  BatchCancel,
  CancelByCloid,
  ScheduleCancel,
  CancelAllOrders,
  // Scale-ladder actions.
  ScaleDist,
  ScaleOrder,
  CancelScale,
  // Chase-order actions.
  ChaseOrder,
  CancelChase,
  // Account / margin / agent actions.
  UpdateLeverage,
  UpdateIsolatedMargin,
  TopUpIsolatedOnlyMargin,
  UserPortfolioMargin,
  SetDisplayName,
  SetReferrer,
  ApproveAgent,
  ApproveBrokerFee,
  ApproveBuilderFee,
  ConvertToMultiSigUser,
  UserSetAbstraction,
  AgentSetAbstraction,
  PriorityBid,
  // Sub-accounts / staking moves / Core↔EVM transfer (typed scheme).
  CreateSubAccount,
  SubAccountTransfer,
  SubAccountSpotTransfer,
  CDeposit,
  CWithdraw,
  CoreEvmTransfer,
  SendToEvmWithData,
  // TWAP.
  TwapOrder,
  TwapCancel,
  // Staking.
  TokenDelegate,
  ClaimRewards,
  LinkStakingUser,
  // Encrypted orders.
  SubmitEncryptedOrder,
  // Vaults.
  VaultKind,
  WholeShares,
  CreateVault,
  VaultTransfer,
  VaultModify,
  VaultWithdraw,
  VaultDistribute,
  // MetaBridge.
  MbChain,
  MbWithdraw,
  // RFQ / FBA.
  CoreSide,
  RfqRequest,
  RfqQuote,
  RfqAccept,
  FbaSubmit,
  // EIP-712 typed-action payloads (structured wallet-signing path).
  MetafluxChainTag,
  SendAsset,
  UsdClassTransfer,
  Withdraw,
} from './types/index.js';
