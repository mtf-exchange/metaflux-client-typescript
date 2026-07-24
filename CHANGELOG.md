# Changelog

All notable changes to the TypeScript SDK are documented here.

## [Unreleased]

### 0.14.0 — typed-only `/exchange`: dead-route removal + coverage fixes (BREAKING)

The node accepts ONLY the typed EIP-712 `/exchange` scheme now; the opaque
`MetaFluxAction(string action,uint64 nonce)` scheme and the CCXT / legacy
`/ccxt/*` + `/v1/orders` routes are gone. This release removes every dead route
and re-points the reads.

**Removed (BREAKING):**

- `Client.getMarkets()` / `Client.getPositions()` — hit the deleted `/ccxt/*`
  routes (404). Use `client.info.markets()` and
  `client.info.accountState(address)` instead.
- `Client.signOrder()` / `Client.submitOrder()` — the old msgpack `/v1/orders`
  envelope (dead). Use `client.submitOrderNative()`.
- The opaque WS post lane. `WsClient.postAction(actionJson)` is replaced by the
  typed `WsClient.postAction(actionType, payload, opts?)`; `submitOrder` /
  `cancelOrder` now sign the typed digest.
- The `TradeOpts.legacy` flag (the opaque-scheme opt-out).

**Fixed (every write now builds a node-accepted typed digest):**

- The ~28 dedicated `/exchange` methods that formerly signed the removed opaque
  digest (`setPositionMode`, `updateLeverage`, `approveAgent`, `createVault`,
  `vaultDistribute`, `claimRewards`, `mbWithdraw`, …) now sign the typed digest.
  Each is byte-identical to the generic `submitTyped(<tag>, payload)` path.

**Deprecated:**

- `spotMarginDeposit` / `spotMarginWithdraw` (+ their `*Typed` twins) — the node
  REJECTS them once the `spot_margin_cross` fork arms (live). Use
  `spotMarginOpen` / `spotMarginClose`.

**Added (P1 completeness):**

- `Client.rfqQuote(params, opts)` — the maker RFQ leg (`rfq_quote`), with an
  owner-carrying digest via `opts.owner`. RFQ can now complete end-to-end.
- `Client.claimBuilderRewards()` / `Client.claimReferralRewards()`.
- WS channels `open_orders` (per-account) and `markets` (global) — 21 total.
- Node-authoritative digest KATs for `rfq_quote` (owner-less + with-owner),
  `vault_distribute`, and the two claims, pinned to the node's own
  `typed_action_kat_vectors` output.

### Chase orders

The SDK now builds and signs chase orders. A chase order places one resting leg
and re-prices it toward the touch on a fixed cadence, until the fill completes,
the lifetime elapses, or the reprice budget runs out. New surface:

- `Client.placeChase(params)` / `Client.cancelChase(params)`.
- `buildNativeChaseOrderAction` / `buildNativeCancelChaseAction` action builders.
- `ChaseOrder` / `CancelChase` param types.
- EIP-712 typed-data encoding for `chase_order` / `cancel_chase`, both owner-less
  and with an agent-resolved `owner`. The digest is byte-exact to the node and
  pinned by known-answer vectors in `__tests__/chase_order.test.ts`.

Each reprice re-stamps the same `cloid` and emits a new leg order id under it.
There is no chase-specific feed: track a chase on the `open_orders` /
`order_updates` channels by `cloid`, and keep the `chase_oid` from the placement
response for `cancelChase`.

## [0.7.17] Backend Compatibility

### Fee Precision

The `/info` fee schedule response now supports finer granularity for fee rates. Fee fields (`maker_bps`, `taker_bps`, `builder_rebate_bps`, `referrer_share_bps`) are decimal basis-point strings with optional fractional digits — for example, `"5.0"` (5 bps) or `"0.5"` (half a bps). The SDK already types these as `string`, so clients parsing them as decimal numbers are unaffected; clients that previously assumed integer basis points must update to handle the fractional component.

### EVM Transaction Signature Verification

The network now verifies EVM transaction signatures at the consensus layer. EVM transactions must be submitted as standard Ethereum raw transactions via `eth_sendRawTransaction` with RLP-encoded signed transaction bytes. The network validates that the signature recovers to the declared sender, preventing Byzantine proposers from forging transaction senders. Standard EVM clients and wallets that already send properly-signed raw transactions are unaffected.
