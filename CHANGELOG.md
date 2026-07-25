# Changelog

All notable changes to the TypeScript SDK are documented here.

## [Unreleased]

### Read surface realigned — `/info` responses + WS channels (BREAKING)

The node redesigned its client-facing READ surface. This release
re-points every read DTO, method, and WS channel at the new wire. The write
(`/exchange`) plane is UNCHANGED — order params keep `side: 'bid' | 'ask'`, and
the `approve_agent` action keeps `expires_at_ms`.

**Renamed (BREAKING):**

- Side tokens are `"B"` / `"A"` everywhere a row carries a side —
  `open_orders`, `order_status` (both branches), and the WS `order_updates`
  inner order. The old `"bid"` / `"ask"` read tokens are gone.
- The size key on order, book, and trade rows is `sz`. `OpenOrder.size`,
  `L2Level.size`, `RestingOrderStatus.size`, and `TriggerOrderStatus.size` are
  all `sz` now.
- Every `/info` TIMESTAMP field dropped its `_ms` suffix:
  `OpenOrder.inserted_at_ms` → `inserted_at`, `RestingOrderStatus`
  `inserted_at_ms` → `inserted_at`, `TriggerOrderStatus.registered_at_ms` →
  `registered_at`, `AgentEntry.expires_at_ms` → `expires_at`,
  `FundingSample.ts_ms` → `ts`, `PredictedFunding.next_funding_time` →
  `next_funding_ts`, `RecentTrades.last_trade_ms` → `last_trade`,
  `BlockInfo.timestamp_ms` → `timestamp`, `PmSummary.enrolled_at_ms` →
  `enrolled_at`, `Mip3Bid.submitted_at_ms` → `submitted_at`,
  `Mip3ActiveBids.auction_end_ms` / `started_at_ms` → `auction_end` /
  `started_at`, `ExchangeStatus.post_only_until_time_ms` →
  `post_only_until_time`, `SpotDeployState.auction_end_ms` / `started_at_ms` →
  `auction_end` / `started_at`, `ValidatorSummary.jailed_at_ms` /
  `unjail_at_ms` → `jailed_at` / `unjail_at`, and
  `ValidatorL1Vote.submitted_at_ms` → `submitted_at`.
- DURATIONS KEEP their `ms` suffix. `VaultState.lock_period_ms` and
  `Funding.interval_ms` are unchanged. Do not apply a blanket `_ms` strip.
- `AccountState.positions` (a flat array) → `AccountState.clearinghouse_state`,
  an object keyed by perp dex. The core dex key is the empty string `""` and is
  always present; a MIP-3 deployer dex keys by the deployer address.
- `AccountState.balances` is an ARRAY of `{asset, name, total, hold}` token
  rows, USDC first. The old `{usdc, usdc_evm_contract, spot}` object is gone,
  and so are the per-token `value` / `evm_contract` / `pnl` sub-fields. An
  all-zero token row is SKIPPED.
- `SpotMarginAccount.pair` is the pair NAME (e.g. `"BTC/USDC"`), not a numeric
  pair id.
- `VaultState.share_price` keeps its key but CHANGES PLANE: it is whole USDC
  per WHOLE share at full precision. A client that still multiplies by the
  share scale reads the price 1e18 times too high. `tvl` and `high_water_mark`
  are whole USDC, not cents — the old doc comments were wrong.
- The WS `order_updates` inner order renamed `limit_px` → `px`.

**Removed (BREAKING):**

- `InfoApi.frontendOpenOrders()` and the `FrontendOpenOrders` /
  `FrontendOpenOrder` types. The node dropped the kind; an unknown kind now
  answers `400`. Use `openOrders()` — it carries the same detail.
- The WS `spot_state` channel and `WsClient.subscribeSpotState()`. A subscribe
  answers with the error envelope. Compose `account_state` + `web_data`
  instead. The REST `spotClearinghouseState()` read is unaffected.
- `AccountState.maint_margin`. It stays on the `margin_summary` read only.
- The `Balances` and `SpotHolding` types.

**Added:**

- `InfoApi.webData(address)` and the `WebData` / `WebDataVault` /
  `WebDataStaking` types — the consolidated account snapshot (vault, staking,
  sub-accounts, multisig, agents). `height` / `time` are FLAT at the top level.
- WS channels `web_data` and `spot_margin_state`, with
  `WsClient.subscribeWebData()` and `WsClient.subscribeSpotMarginState()`. The
  native channel count is 22.
- `WsFrame.is_snapshot` — `true` marks an on-subscribe full snapshot; `false`
  or absent marks a delta.
- The enriched `OpenOrder` row: `orig_sz`, `tif`, `reduce_only`, and a folded
  `trigger` block. A parked TP / SL / stop row is in the row set with
  `tif: "trigger"`. The new `OrderTif` type accepts that non-TIF token, and
  `OrderTrigger` moved beside the order row.
- `AccountState.pm_maint_margin` / `pm_net_value` /
  `pm_concentration_penalty` — the folded portfolio-margin figures, whole USDC,
  always present (`"0"` when not enrolled). Gate the meaning on
  `abstraction === 'portfolio'`. The standalone `pmSummary()` read KEEPS its
  cents-plane `*_cents` names.
- `AccountPosition.maint_margin`.
- `AccountState.height` / `time` and `SpotClearinghouseState.height` / `time`.
  The stamp is NOT uniform across reads — `spot_margin_state` carries none.
- `EarnPool.name` — the token symbol beside the numeric `asset`.
- `DexPositions` and `TokenBalance` types; `SpotBalance` is now an alias of
  `TokenBalance`.

**Unchanged, and easy to get wrong:**

- The `account_state` POSITION size key is `size` and it is SIGNED. Only order,
  book, and trade rows use `sz`.
- The position `side` is a hedge LEG LABEL (`"long"` / `"short"`) and is absent
  on a one-way account. It is not the `"B"` / `"A"` side token.
- `SpotMarginParams.init_bps` / `maint_bps` stay JSON STRINGS of integers, while
  `performance_fee_bps` and the other bps fields stay raw numbers.

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
