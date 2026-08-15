// Re-export barrel for every type module.
//
// Keeping the type surface behind one barrel means internal modules import from
// `../types/index.js` and the public `src/index.ts` re-exports from here.

export type {
  Order,
  Builder,
  SignedOrder,
  OrderAck,
  Market,
  Position,
  Side,
  Tif,
  StpMode,
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
  NativeSignedAction,
  NativeExchangeAck,
  OrderStatus,
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
} from './trading.js';
export type {
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
} from './place.js';
export type {
  NativeSpotOrder,
  NativeSpotCancel,
  NativeSpotMarginDeposit,
  NativeSpotMarginWithdraw,
  NativeSpotMarginOpen,
  NativeSpotMarginClose,
  NativeEarnDeposit,
  NativeEarnWithdraw,
} from './spot.js';
export type {
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
  CreateSubAccount,
  SubAccountTransfer,
  SubAccountSpotTransfer,
  CDeposit,
  CWithdraw,
  CoreEvmTransfer,
} from './account.js';
export type { TokenDelegate, ClaimRewards, LinkStakingUser } from './staking.js';
export type { TwapOrder, TwapCancel } from './twap.js';
export type { MbChain, MbWithdraw } from './meta-bridge.js';
export type {
  VaultKind,
  WholeShares,
  CreateVault,
  VaultTransfer,
  VaultModify,
  VaultWithdraw,
  VaultDistribute,
} from './vault.js';
export { sharesToWire } from './vault.js';
export type { SubmitEncryptedOrder } from './encrypted.js';
export type { CoreSide, RfqRequest, RfqQuote, RfqAccept } from './rfq.js';
export type { FbaSubmit } from './fba.js';
export type {
  // EIP-712 typed-action payloads (the structured wallet-signing path).
  MetafluxChainTag,
  SendAsset,
  UsdClassTransfer,
  Withdraw,
} from './typed.js';
