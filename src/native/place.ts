// Unified order placement — route a mixed-arity request onto the order wire.
//
// The wire has three order actions. `planPlaceOrder` picks one per request and
// builds the SAME canonical bytes the per-action builders produce, so a unified
// call and a hand-built call sign the identical digest.

import {
  buildNativeBatchOrderAction,
  buildNativeSpotOrderAction,
} from './actions.js';
import type {
  BatchOrder,
  NativeOrder,
  NativeSpotOrder,
  PlaceOrderLeg,
  PlaceOrderOpts,
  PlaceOrderPlan,
  SpotPlaceResult,
} from '../types/index.js';

/// Thrown when the spot route stops part-way. The wire cannot batch spot, so
/// the route sends one action per leg; a failure leaves the earlier actions
/// already sent. `result` records what each action did.
export class PlaceOrderPartialError extends Error {
  /// Per-action outcome, in submission order. Entries before the failure are
  /// `"sent"` and MAY already be committed.
  readonly result: SpotPlaceResult;

  constructor(result: SpotPlaceResult, reason: string) {
    const sent = result.submissions.filter((s) => s.state === 'sent').length;
    const total = result.submissions.length;
    super(
      `spot placement stopped after ${sent} of ${total} actions: ${reason}. ` +
        'Each spot_order is an independent action — the sent ones may already be committed.',
    );
    this.name = 'PlaceOrderPartialError';
    this.result = result;
  }
}

/// Decide which wire action a unified placement request lowers to, and build
/// its canonical bytes. Pure: it signs nothing and sends nothing.
///
/// Routing:
/// - all-perp, any count → ONE `batch_order`. A single perp order takes this
///   route too, so the request shape and the reply shape do not change with the
///   leg count.
/// - all-spot → ONE `spot_order` PER leg. `batch_order` carries perp
///   `NativeOrder` legs only, so the wire cannot batch spot.
/// - MIXED perp and spot → rejected. Two venues cannot share one action, and
///   splitting the request silently would turn one submission the caller
///   believes is atomic into two independent ones.
///
/// `opts.owner` rides BOTH routes: the perp route puts it on the `batch_order`
/// top level, the spot route on every leg that omits its own `owner`.
///
/// The plan is a pure lowering. It does NOT convert numbers between planes:
/// `limit_px` stays in the 1e8 book plane and `size` stays in raw lots, exactly
/// as the caller supplied them.
export function planPlaceOrder(
  legs: PlaceOrderLeg | readonly PlaceOrderLeg[],
  opts: PlaceOrderOpts = {},
): PlaceOrderPlan {
  const list: readonly PlaceOrderLeg[] = Array.isArray(legs) ? legs : [legs];
  if (list.length === 0) {
    throw new RangeError('placeOrder requires at least one order');
  }

  const perp: NativeOrder[] = [];
  const spot: NativeSpotOrder[] = [];
  for (const [index, leg] of list.entries()) {
    if (leg.venue === 'perp') {
      perp.push(stripVenue(leg));
    } else if (leg.venue === 'spot') {
      spot.push(stripVenue(leg));
    } else {
      throw new RangeError(
        `placeOrder order ${index}: venue must be "perp" or "spot"`,
      );
    }
  }

  if (perp.length > 0 && spot.length > 0) {
    throw new RangeError(
      'placeOrder cannot mix perp and spot orders: perp legs ride one batch_order ' +
        'and spot legs ride one spot_order each, so a mixed request has no single ' +
        'wire action. Split it into two calls and handle each result separately.',
    );
  }

  if (perp.length > 0) {
    const batch: BatchOrder = { orders: perp };
    if (opts.owner !== undefined) batch.owner = opts.owner;
    if (opts.grouping !== undefined) batch.grouping = opts.grouping;
    return {
      route: 'batch_order',
      batch,
      actionJson: buildNativeBatchOrderAction(batch),
    };
  }

  if (opts.grouping !== undefined) {
    throw new RangeError(
      'placeOrder: grouping is a batch_order field; the spot_order wire cannot carry it',
    );
  }
  // Each spot leg is its own action, so each needs its own nonce. Reusing one
  // explicit nonce replays it and the node drops every action after the first.
  if (opts.nonce !== undefined && spot.length > 1) {
    throw new RangeError(
      'placeOrder: an explicit nonce fits one spot order only; ' +
        `${spot.length} spot orders send ${spot.length} actions, each needing its own nonce`,
    );
  }

  const requestOwner = opts.owner;
  const owned =
    requestOwner === undefined ? spot : spot.map((o) => withOwner(o, requestOwner));
  return {
    route: 'spot_order',
    orders: owned,
    actionJson: owned.map(buildNativeSpotOrderAction),
  };
}

/// Apply the request-level `owner` to one spot leg. A leg that already names a
/// DIFFERENT owner is refused — one call cannot sign two owners for one leg.
function withOwner(order: NativeSpotOrder, owner: string): NativeSpotOrder {
  if (order.owner === undefined) return { ...order, owner };
  if (order.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new RangeError(
      `placeOrder: order owner ${order.owner} differs from opts.owner ${owner}`,
    );
  }
  return order;
}

function stripVenue<T extends { venue: string }>(leg: T): Omit<T, 'venue'> {
  const { venue: _venue, ...rest } = leg;
  return rest;
}
