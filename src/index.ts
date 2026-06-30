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
  type TypedDataV4,
  type TypedSignedAction,
} from './native/typed.js';
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
  buildNativeApproveBuilderFeeAction,
  buildNativeConvertToMultiSigUserAction,
  buildNativeUserDexAbstractionAction,
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
  buildNativeSetMetaliquidityWhitelistAction,
  buildNativeRegisterMetaliquidityOperatorAction,
  // cross-chain (forward-compat) builder. RFQ / FBA / encrypted-order are now
  // signed via the W1 typed path (`Client.rfqRequest` / `rfqAccept` / `fbaSubmit`
  // / `encryptedOrderSubmit` → `submitTyped`), not opaque action builders.
  buildNativeCrossChainSendAction,
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
  // MTF-native `/info` read API + the account-ref union (address | account_id).
  InfoApi,
  type AccountRef,
} from './rest/info.js';
export type {
  // MTF-native `/info` response shapes. Source of truth:
  // the KB spec `metaflux-knowledges/api/rest/info.md`. Every field is the exact
  // snake_case key the node emits inside the `{type, data}` envelope's `data`.
  NodeInfo,
  AccountState,
  AccountPosition,
  Balances,
  Tier,
  MarginMode,
  MarketInfo,
  MarketKind,
  Funding,
  VaultState,
  StakingState,
  Delegation,
  PendingUnstake,
  FeeSchedule,
  FeeTier,
  OpenOrders,
  OpenOrder,
  L2Book,
  L2Level,
  RecentTrades,
  RecentTrade,
  UserFills,
  UserFill,
  FundingHistory,
  FundingSample,
  BlockInfo,
  Agents,
  AgentEntry,
  SubAccounts,
  SubAccountEntry,
  Mip3ActiveBids,
  Mip3Bid,
  // HL-node parity shapes.
  SpotMeta,
  SpotPair,
  SpotToken,
  SpotClearinghouseState,
  SpotBalance,
  ExchangeStatus,
  PerpAssetCtx,
  SpotAssetCtx,
  FrontendOpenOrders,
  FrontendOpenOrder,
  OrderTrigger,
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
  MarginTable,
  MarginTier,
  PerpDexs,
  PerpDex,
  ValidatorSummaries,
  ValidatorSummary,
  GossipRootIps,
  WebData2,
  WebData2Clearinghouse,
  WebData2Position,
} from './types/info/index.js';
export {
  // MTF-native WebSocket client + subscription/channel types.
  WsClient,
  WS_CHANNELS,
  type WsChannel,
  type WsSubscription,
  type WsFrame,
  type WsMessageHandler,
  type WsConfig,
  type WsSigner,
  type AllMids,
  type ActiveAssetCtx,
  type ActiveAssetDataFrame,
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
  // Order-management actions.
  OrderGrouping,
  Modify,
  BatchModify,
  BatchOrder,
  BatchCancel,
  CancelByCloid,
  ScheduleCancel,
  CancelAllOrders,
  // Account / margin / agent actions.
  UpdateLeverage,
  UpdateIsolatedMargin,
  TopUpIsolatedOnlyMargin,
  UserPortfolioMargin,
  SetDisplayName,
  SetReferrer,
  ApproveAgent,
  ApproveBuilderFee,
  ConvertToMultiSigUser,
  UserDexAbstraction,
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
  // TWAP.
  TwapOrder,
  TwapCancel,
  // Staking.
  TokenDelegate,
  ClaimRewards,
  LinkStakingUser,
  // Encrypted orders.
  SubmitEncryptedOrder,
  EncryptedOrderSubmit,
  // Vaults.
  VaultKind,
  CreateVault,
  VaultTransfer,
  VaultModify,
  VaultWithdraw,
  VaultDistribute,
  // MetaBridge.
  MbChain,
  MbWithdraw,
  // Governance / operator.
  SetMetaliquidityWhitelist,
  RegisterMetaliquidityOperator,
  // RFQ / FBA / cross-chain (forward-compat).
  CoreSide,
  RfqRequest,
  RfqAccept,
  FbaSubmit,
  CrossChainSend,
  // EIP-712 typed-action payloads (structured wallet-signing path).
  MetafluxChainTag,
  SendAsset,
  UsdClassTransfer,
  Withdraw,
  SetMetaliquiditySet,
} from './types/index.js';
