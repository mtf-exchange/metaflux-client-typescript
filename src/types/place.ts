// Unified order-placement types — one entry point over the order wire actions.
//
// A leg tags its venue with `venue`. The tag discriminates the union, so the
// perp and spot field sets stay disjoint at compile time, and it selects the
// wire action: perp legs ride ONE `batch_order`; spot legs ride ONE `spot_order`
// EACH, because the wire cannot batch spot.

import type { NativeSpotOrder } from './spot.js';
import type {
  BatchOrder,
  NativeExchangeAck,
  NativeOrder,
  OrderGrouping,
  OrderStatus,
} from './trading.js';

/// One perp leg of a unified placement request — a [`NativeOrder`] tagged
/// `"perp"`. Perp legs key on `market` and may carry `reduce_only`, `builder`,
/// `position_side` and `trigger`.
export interface PerpOrderLeg extends NativeOrder {
  venue: 'perp';
}

/// One spot leg — a [`NativeSpotOrder`] tagged `"spot"`. Spot legs key on
/// `pair`. Spot has no positions, so a spot leg has no `reduce_only`,
/// `builder`, `position_side` or `trigger`, and it uses a SEPARATE id space
/// from `market`.
export interface SpotOrderLeg extends NativeSpotOrder {
  venue: 'spot';
}

/// One leg of a unified placement request. `venue` discriminates the union, so
/// a perp-only field on a spot leg is a compile error.
export type PlaceOrderLeg = PerpOrderLeg | SpotOrderLeg;

/// Per-call options for a unified placement request.
export interface PlaceOrderOpts {
  /// Per-account replay nonce. Defaults to a strictly-increasing unix-ms clock.
  /// The spot route sends one action per leg, so an explicit nonce is REJECTED
  /// for more than one spot leg — every action needs its own nonce.
  nonce?: bigint;
  /// EIP-712 domain chain id. Defaults to `MTF_CHAIN_ID` (testnet 114514).
  chainId?: number;
  /// PERP ROUTE ONLY: the `batch_order` top-level owner (agent-as-vault
  /// routing). The spot wire has no place for it, so a spot request that sets
  /// it is REJECTED instead of dropping it.
  owner?: string;
  /// PERP ROUTE ONLY: `batch_order` grouping. Defaults to `"na"`. The spot wire
  /// has no place for it, so a spot request that sets it is REJECTED.
  grouping?: OrderGrouping;
}

/// The perp plan — every leg rides ONE `batch_order` action.
export interface BatchOrderPlan {
  route: 'batch_order';
  /// The `batch_order` payload, ready for `Client.batchOrder`.
  batch: BatchOrder;
  /// Canonical action bytes. Identical to
  /// `buildNativeBatchOrderAction(batch)`.
  actionJson: string;
}

/// The spot plan — one `spot_order` action PER leg, in submission order.
export interface SpotOrderPlan {
  route: 'spot_order';
  /// One `spot_order` payload per leg, ready for
  /// `Client.submitSpotOrderNative`.
  orders: NativeSpotOrder[];
  /// Canonical action bytes per leg. Each entry is identical to
  /// `buildNativeSpotOrderAction(orders[i])`.
  actionJson: string[];
}

/// What a unified placement request lowers to on the wire. Inspect it to see
/// which action reaches the chain before you submit.
export type PlaceOrderPlan = BatchOrderPlan | SpotOrderPlan;

/// One leg of a committed `batch_order`, in submission order.
export interface PlacedLeg {
  /// Position of this leg in the submitted array.
  index: number;
  /// Client order id this leg was submitted with, when it carried one.
  cloid?: string;
  /// Node status for this leg. Absent when the node returned no status entry
  /// for it — for example when the whole action was rejected at admission.
  status?: OrderStatus;
}

/// Result of the perp route. ONE signed action carried every leg, and the node
/// answers with one status per placed leg.
export interface BatchPlaceResult {
  route: 'batch_order';
  /// The single `/exchange` ack for the whole batch.
  ack: NativeExchangeAck;
  /// One entry per submitted leg, in submission order.
  legs: PlacedLeg[];
}

/// Fields shared by every [`SpotSubmission`] state.
export interface SpotSubmissionBase {
  /// Position of this leg in the submitted array.
  index: number;
  /// Client order id this leg was submitted with, when it carried one.
  cloid?: string;
}

/// One `spot_order` action of the spot route. Each action is independent: an
/// earlier one can commit while a later one fails.
export type SpotSubmission =
  /// The action reached the node and the node answered.
  | (SpotSubmissionBase & { state: 'sent'; ack: NativeExchangeAck })
  /// The action failed. Earlier actions may already be committed.
  | (SpotSubmissionBase & { state: 'failed'; error: string })
  /// The action was never sent, because an earlier one failed first.
  | (SpotSubmissionBase & { state: 'not_sent' });

/// Result of the spot route. The wire cannot batch spot, so this is N SEPARATE
/// signed actions with N nonces — NOT one submission. Read every entry.
export interface SpotPlaceResult {
  route: 'spot_order';
  /// One entry per leg, in submission order.
  submissions: SpotSubmission[];
}

/// Result of a unified placement request. The two routes share no payload key,
/// so a caller must narrow on `route` before reading a result and cannot treat
/// the N-action spot route as one submission.
export type PlaceOrderResult = BatchPlaceResult | SpotPlaceResult;
