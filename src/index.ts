// Public barrel — every export consumers see goes through this file.
//
// Pinning the public surface here means we can refactor the internal
// `client.ts` / `wallet/wasm.ts` / `rest/http.ts` split without touching
// anything import-facing. The npm package `exports` map points at the compiled
// `dist/index.js`, so consumers write:
//
//     import { Client, type Order } from '@metaflux-dex/client';

export { Client, type ClientOpts } from './client.js';
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
} from './native/digest.js';
export {
  // MTF-native action builders (the path the server now accepts).
  buildNativeOrderAction,
  buildNativeCancelAction,
  buildNativeSetPositionModeAction,
  buildNativeSpotOrderAction,
  buildNativeSpotCancelAction,
  // New native write actions (vault / portfolio-margin / RFQ / FBA /
  // cross-chain / encrypted).
  buildNativeVaultCreateAction,
  buildNativeVaultDistributeAction,
  buildNativeVaultWithdrawAction,
  buildNativePmEnrollAction,
  buildNativePmUnenrollAction,
  buildNativePmRebalanceAction,
  buildNativeRfqRequestAction,
  buildNativeRfqAcceptAction,
  buildNativeFbaSubmitAction,
  buildNativeCrossChainSendAction,
  buildNativeEncryptedOrderSubmitAction,
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
  UserFills,
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
  NativeSide,
  NativePositionSide,
  NativeOrderKind,
  NativeTif,
  NativeStpMode,
  NativeSetPositionMode,
  NativeSpotOrder,
  NativeSpotCancel,
  NativeSignedAction,
  NativeExchangeAck,
  // New native write-action payload types.
  VaultCreate,
  VaultDistribute,
  VaultWithdraw,
  PmEnroll,
  PmUnenroll,
  PmRebalance,
  RfqRequest,
  RfqAccept,
  FbaSubmit,
  CrossChainSend,
  EncryptedOrderSubmit,
} from './types/index.js';
