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
} from './trading.js';
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
  ApproveBuilderFee,
  ConvertToMultiSigUser,
  UserDexAbstraction,
  UserSetAbstraction,
  AgentSetAbstraction,
  PriorityBid,
} from './account.js';
export type { TokenDelegate, ClaimRewards, LinkStakingUser } from './staking.js';
export type { TwapOrder, TwapCancel } from './twap.js';
export type {
  SetMetaliquidityWhitelist,
  RegisterMetaliquidityOperator,
} from './governance.js';
export type { MbChain, MbWithdraw } from './meta-bridge.js';
export type {
  VaultKind,
  CreateVault,
  VaultTransfer,
  VaultModify,
  VaultWithdraw,
  VaultDistribute,
} from './vault.js';
export type { SubmitEncryptedOrder, EncryptedOrderSubmit } from './encrypted.js';
export type { CoreSide, RfqRequest, RfqAccept } from './rfq.js';
export type { FbaSubmit } from './fba.js';
export type { CrossChainSend } from './cross-chain.js';
export type {
  // EIP-712 typed-action payloads (the structured wallet-signing path).
  MetafluxChainTag,
  SendAsset,
  UsdClassTransfer,
  Withdraw,
  SetMetaliquiditySet,
} from './typed.js';
