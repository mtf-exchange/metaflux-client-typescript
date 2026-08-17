# Changelog

All notable changes to the TypeScript SDK are documented here.

## [Unreleased] — staged as 0.16.0

The Rust SDK ships the same wire realignment as its 0.16.0. The two SDKs stay in
step, so this release takes the same number.

### A Core → MetaFluxEVM move charges a fee in MTF

Both lanes charge it — `coreEvmTransfer` and `sendToEvmWithData` — through one
shared quote, so neither is the cheaper route. **The fee is ZERO today, so no fee
is charged.** Chain governance sets the amount, and it can become non-zero with no
SDK release. This entry is documentation: no type or payload changed.

The fee is a quantity of MTF, debited on TOP of the amount. It is unrelated to the
token you move: a BTC transfer debits BTC for the amount and MTF for the fee. It
resolves as spot MTF first, then USDC at the MTF reference price. Staked MTF does
not pay it, and the USDC step draws on FREE collateral.

**No read returns the fee amount, so a client cannot pre-compute it.** The refusal
is the only signal, which makes these three strings the whole UI contract:

- `insufficient MTF or USDC for the core->evm fee` — neither ledger covers the fee.
  ONE string covers both shortfalls, so it never says which ledger was short.
- `MTF price unavailable; the core->evm fee cannot be quoted in USDC`
- `the core->evm fee does not convert to a positive USDC amount`

The last two are the rule callers get wrong. MTF is priced from its own market, so
the reference price can be unusable — never set, or the market moved away from it.
The transfer is then REFUSED, not charged at a guessed price. **A move can fail for
a reason unrelated to the token you move and unrelated to your balance of it**, so
a UI that only ever says "insufficient balance" will mislead a user.

A refused transfer pays nothing.

### `send_to_evm_with_data` is signable again

`POST /exchange` takes `send_to_evm_with_data`, and the SDK could not express it.
It now types it, signs it and sends it: the `SendToEvmWithData` type,
`client.sendToEvmWithData({ … })`, and the signing string

```
MetaFluxTransaction:SendToEvmWithData(string metafluxChain,uint32 token,string amount,uint32 sourceDex,address destinationRecipient,bool toPerp,uint32 destinationChainId,bytes data,uint64 transferNonce,uint64 nonce)
```

The digest is pinned against the server's own fixture, so a signature this SDK
makes verifies on arrival.

The action moves the same value as `coreEvmTransfer` and takes the same payload.
It adds three signed slots. **Each slot refuses a value it cannot honour; it is
never accepted and then ignored.**

- `source_dex` — `0` only. The action debits one ledger.
- `to_perp` — `false` only. The EVM side has no perp account.
- `destination_chain_id` — `0` or the local EVM chain id only. Cross-chain
  delivery is not built.

**A historical payload carries `source_dex: 1`, so it is rejected today.** Send
`0` or omit the key. The client defaults all three slots to the accepted value,
so an omitted field cannot produce a payload the node then refuses.

Two more rules:

- `data` is capped at 4096 bytes. A reverting payload NEVER unwinds the credit —
  read its receipt.
- An `amount` that truncates to a ZERO EVM credit is rejected. The lane truncates
  toward zero twice, to 8 decimal places and then to the token's own EVM
  decimals, and the debit equals the truncated credit.

`params.nonce` is a transfer tag, signed as `transferNonce`. It is NOT the replay
guard: the envelope nonce still is.

### The approve-fee action tag moves to `approve_broker_fee`

`POST /exchange` now takes `approve_broker_fee`. The node accepts BOTH names, so
an old client keeps working; this SDK emits the new one. `approveBrokerFee` and
`buildNativeApproveBrokerFeeAction` are the canonical names. `approveBuilderFee`
and `buildNativeApproveBuilderFeeAction` stay as old names and now emit the new
tag. `ApproveBrokerFee` is an alias of `ApproveBuilderFee`.

**Deploy the node before you upgrade.** A node binary that predates the alias
rejects the new tag.

The EIP-712 type string stays
`MetaFluxTransaction:ApproveBuilderFee(string metafluxChain,address builder,uint16 maxFeeBps,uint64 nonce)`.
It is consensus-frozen: one changed byte breaks verification of every historical
signature. The wire tag and the signing string therefore differ on purpose.

### An approved agent may sign an owner-carrying action (fix)

The client required every `owner` to equal the recovered signer. The node does
not: it admits the owner AND any agent the owner approved. The old check
therefore refused, inside the process, every agent order the chain would have
taken — the normal case where a session key signs for its master.

The client now recovers the signer and, only when it differs from `owner`, reads
the owner's approved agents from `/info agents`. An unrelated address — a
mistyped `owner` — still throws locally, before the action burns a nonce. Notes:

- Only a positive answer is cached, keyed `(owner, signer)`. A cached refusal
  would keep blocking an agent that the owner approved seconds ago.
- An unreachable `/info` does NOT block the action. The node re-runs the same
  check at admission and stays the authority; the client never guesses.

A batch acts for ONE account. The node routes the whole batch under the
top-level `owner`, or under the signer when the batch names none, and IGNORES
the per-item `owner` fields. A leg that names another account is a caller
mistake, and it now throws with the fix in the message. `batch_cancel` gains the
same top-level `owner`, on the wire and in the typed digest, so an agent can
cancel for its master under one signature.

### Candles carry a `candle_type`, and fold a price series (BREAKING)

`candle_snapshot` and the `candles` WS channel take `candle_type`. `mark` is the
default and serves perp and spot; `oracle` serves perp only and answers empty
for a spot pair. The field rides only when given, so an existing caller keeps
byte-identical request bytes. The executed-trade candle is RETIRED: the node
rejects `trade` and never substitutes another series.

A bar folds a SAMPLED price series, not trades. `v` and `q` are always `"0"`,
and `n` counts samples, not fills. The series is gapless: a window with no
sample carries the previous close forward as a flat bar (`o = h = l = c`,
`n = 0`). Do not build wick analysis on these bars — a spike between two samples
leaves no trace. Read executions from `recent_trades` / `trades_by_time`.

The WS routing key is now the triple (coin, interval, candle_type). Mark and
oracle at one interval are two subscriptions, and both replay after a reconnect.

### One order entry point: `placeOrder` (additive)

Placing an order needed a different call per shape: `submitOrderNative` for one
perp order, `batchOrder` for several, `submitSpotOrderNative` for spot. The
caller had to know which wire action to reach for.

`client.placeOrder(orders, opts?)` takes one order or many and routes:

- all-perp, any count → ONE `batch_order`. It carries `grouping` and the
  top-level `owner` (agent-as-vault routing), and the node returns one status
  per placed leg.
- all-spot → ONE `spot_order` action PER order. `batch_order` legs are perp
  orders, so the wire cannot batch spot.
- MIXED perp and spot → REJECTED, naming the reason. A silent split would turn
  one submission the caller believes is atomic into two independent ones.

Each order carries a `venue` tag (`"perp"` / `"spot"`). It discriminates the
`PlaceOrderLeg` union, so a perp-only field on a spot order is a compile error
rather than a runtime throw.

The result narrows on `route` and the two routes share no payload key: the
batch route returns `ack` + per-leg `legs`, the spot route returns per-action
`submissions`. The spot route cannot be read as one submission. A spot action
that fails stops the run and throws the new `PlaceOrderPartialError`, which
carries the same per-action record so the sent actions stay visible.

`planPlaceOrder(orders, opts?)` is the pure lowering — it returns the route plus
the canonical action bytes without signing or sending, so a caller can inspect
what reaches the chain. Those bytes are byte-identical to the per-action
builders for the same input.

Purely additive: every existing method keeps its behaviour, and `placeOrder`
converts nothing between the 1e8 book plane and raw lots.

### `spot_margin_deposit` / `spot_margin_withdraw` marked deprecated

The node REJECTS both actions while cross-margin is active, which on the live
chain is from genesis. Collateral is the one unified USDC account, so there is
no per-pair bucket to fund or drain. Fund the account instead (a MetaBridge
deposit), then use `spotMarginOpen` / `spotMarginClose`; withdraw account-wide
with `mbWithdraw`.

`spotMarginDeposit`, `spotMarginWithdraw`, their `*Typed` variants, the
`NativeSpotMarginDeposit` / `NativeSpotMarginWithdraw` types and the
`buildNativeSpotMargin*` builders now carry `@deprecated`. Nothing is removed:
the types, builders and EIP-712 type strings stay so an old signature can still
be reconstructed and verified. The README example no longer posts collateral.

### WS channel bodies realigned with the live node wire (BREAKING)

The realignment below covered the `/info` reads. Four WS channel types still
carried a wire that the node does not send, and most channel bodies had no type
at all. This closes both.

**Renamed (BREAKING):**

- `WsUserFunding` now matches the node record `{coin, usdc, szi, funding_rate,
  time}`. `payment` → `usdc`, `fundingRate` → `funding_rate`, and `coin` is a
  market SYMBOL string, not a numeric asset id. This is a settled-cash channel:
  the old keys read as `undefined`, which JS then propagates as `NaN` or a
  silent falsy, never an error. `usdc` also matches the REST `user_funding`
  history record, so a client can seed from REST and merge live deltas.
- `ActiveAssetCtx` is `{coin, ctx}`. Every metric moved into the new
  `ActiveAssetCtxBody`: `mark_px`, `oracle_px`, `mid_px`, `premium`,
  `day_ntl_vlm`, `prev_day_px`, `change_24h`, `funding`, `open_interest`, plus
  the conditional `px_stale`. The type was flat, so every metric read as
  `undefined`. `ctx` is never `null` — the fallback snapshot for an unknown
  market sends a zeroed body.

**Added:**

- `AccountState.health_deferred` (optional). The node emits it ONLY when the
  risk engine defers on the account: it holds a leg no risk path can price. The
  reported maintenance margin is then `0` for want of a price, so `tier` and
  `health` are not solvency statements. The market-side twin is `px_stale`.
- A body type for every channel that returned `unknown`: `WsL2Book`, `WsBbo`,
  `WsL2Level`, `WsCandleFrame`, `WsNodeCandle`, `WsUserEvent`, `WsNotification`,
  `WsLedgerUpdate`, `WsTwapSliceFill`, `WsTwapHistoryRecord`, `WsMarketRow`,
  `WsAccountState`, `WsWebData`, `WsSpotMarginState`. Account-family channels
  reuse the REST DTO the node builds them from.
- `WsChannelData` maps each channel name to its body type, and `isChannelFrame`
  narrows a frame to one channel so the compiler checks each field read.

**Fixed:**

- The `Candle` doc claimed one bar shape across REST and WS. A gateway wraps the
  REST bar in the `WsCandleFrame` envelope, and a node-direct mount sends a
  different bar entirely (`WsNodeCandle`: `coin` / `interval` labels, no `q`).
  Casting the REST type onto a node bar produced a wrong chart with no error.

**Notes:**

- `WsL2Level` spells the per-level order count `n`; the REST `L2Level` spells it
  `n_orders`. Both match their own wire.
- The two TWAP channels keep their camelCase keys (`twapId`, `executedSz`,
  `reduceOnly`). That is the server contract, not a defect.
- `WsSpotMarginState` adds the `height` / `time` stamp that the WS emit path
  injects and the REST read does not.

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

**Internal — the read DTOs are now typechecked:**

- `pnpm typecheck` also runs the `tsconfig.test.json` project, which adds the
  test sources. The base project excludes them, and the test runner transforms
  the tests without typechecking them. A read DTO key could therefore change to
  a wrong value while typecheck, lint, and all tests stayed green. The renames
  above are gated now.

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
