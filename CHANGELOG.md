# Changelog

All notable changes to the TypeScript SDK are documented here.

## [Unreleased]

### Changed

- **Breaking: three read fields change type.** The node serializes every `*_bps`
  field on the public wire as a JSON string, so `max_fee_bps`,
  `performance_fee_bps` and `validator_quorum_threshold_bps` are now `string`.
  The value is unchanged; only the type moves. This lands with the node release
  that makes the change, not before it.

- **Breaking: `TradeRecord.hash` is now optional.** An ABSENT hash and an EMPTY
  hash are different facts and the required `string` collapsed them. Absent means
  NOT RECORDED — an archive-served print, whose table stores no trace hash. `""`
  means recorded, and there was no signed taker action.

- `WsLedgerUpdateKind` names two more kinds and no longer rejects an unknown
  one. `deposit` (a bridge inbound credit) and `liquidation` (a forced-close
  settlement) arrive in a later node release; both are listed now so a caller
  can switch on them before that release ships.

  The union also gained a `(string & {})` member. It keeps the literals as
  editor completions while ACCEPTING a kind this build has never seen — the node
  adds kinds as it attributes more causes, and the closed union made every one
  of them a type error on arrival.

## [0.24.1] — 2026-08-22

### Fixed

- The availability corrections described in 0.24.0 were written but never
  committed, so the published 0.24.0 still told callers these actions answer
  `unknown variant` and that governance has not armed the deployer oracle. Both
  claims are false on the primary networks. This release carries the corrected
  doc comments that 0.24.0 was supposed to.

## [0.24.0] — 2026-08-21

### Added

- `mip3SetOraclePx` and the `Mip3SetOraclePx` params type. A MIP-3 market
  deployer can push their market's index price from their own source. The chain
  has carried the action since its EIP-712 type was frozen, but no client could
  sign it, so the capability was unreachable from TypeScript.

  `px` is a decimal STRING and is signed VERBATIM: the exact bytes passed are the
  bytes hashed and the bytes posted, so a relay can neither reprice a push nor
  re-target it at another market. Only the market's deployer or a registered
  sub-deployer may sign one.

  The digest vector is derived FROM THE NODE, not from this SDK's own output.

### Changed

- **Availability claims corrected — they were false.** The deployer actions do
  NOT answer `unknown variant` on the primary networks; the node knows every
  tag. And `mip3_deployer_oracle` is ACTIVE FROM GENESIS on a chain that started
  fresh, so no stake vote will ever arm it there. Only a legacy or unknown
  network keeps it dormant. Availability is per network: probe one call and read
  the error.

- `Candle.v`, `Candle.q` and `Candle.n` are now OPTIONAL, and `Candle.f` is
  added. The serving layer omits the volume triple when it cannot prove trade
  coverage for a bucket: an ABSENT field means "no volume data", where a `"0"`
  would mean "no trades". Typing them as required made the first uncovered bar
  fail to parse. `f` marks an invented bar (carry-forward or seed) — test it,
  never `n === 0`.

- `TokenEvmContract.address` is documented as the BOUND contract a Core-to-EVM
  transfer credits, not a contract a deployer merely declared at
  `register_token`. `evm_extra_wei_decimals` is that declared value and does not
  change a credit: a credit lands in the token's `wei_decimals`.

### Removed

- `WsNodeCandle`. The node no longer aggregates OHLCV, so the node-direct bar
  shape it described no longer exists. `WsChannelData.candles` narrows from a
  three-way union to `WsCandleFrame`, which removes the `Array.isArray`
  narrowing a client had to write.

## [0.23.0] — 2026-08-21

One BREAKING change: `gossip_root_ips` now returns peer rows, not a string list.

### The break: `GossipRootIps.root_ips` is replaced by `GossipRootIps.peers`

The read used to return a bare list of `host:port` strings. It now returns one
row per advertised node, typed by the new `AdvertisedPeer` interface:

```ts
interface AdvertisedPeer {
  id: number;
  gossip: string;
  peer_rpc: string;
  auth: string;
  pubkey_hex?: string;
}
```

**Why the shape changed.** A bare address list cannot say which node an address
belongs to, cannot carry the other two ports, and cannot carry the public key. A
caller therefore could not act on it. A row maps one-to-one onto a joining
node's own peer config, so the read is usable for peer discovery.

`root_ips` is NOT kept alongside `peers`. The old payload could not express a
node that publishes no address, and keeping both duplicates the same data.

**Migration.** Replace `res.root_ips` with `res.peers.map((p) => p.gossip)` for
the equivalent address list. The method name `gossipRootIps()` and the wire
request type `gossip_root_ips` are unchanged.

**A node that advertises nothing is absent from `peers`.** An empty array is the
honest answer for a deployment that advertises nothing. It is not an error.

**Wire availability.** The node release that serves `peers` has not fired. Until
it does, a live node returns the old `root_ips` payload.

## [0.22.0] — 2026-08-19

Seventeen new signable actions, one type-level break, and two doc corrections.
Seventeen new actions make this a minor; the break is the part that needs a
migration note.

### The break: a raw 10^18 magnitude no longer type-checks as a whole one

`Raw1e18` is a new brand for the RAW 10^18 plane. `ProtocolMetricsEvm
.native_balance_wei` now carries it, because the node sums the `u128` wei field
and serves it unconverted. It is the one read magnitude that is NOT already in
whole units.

**Reading the field still compiles.** `Raw1e18` is a `string` subtype, so
`const s: string = metrics.native_balance_wei` is unchanged, and so is anything
that prints, logs or concatenates it.

**CONSTRUCTING the DTO with a plain `string` no longer compiles.** A mock, a
fixture or a hand-built response object now fails with

```
TS2322: Type 'string' is not assignable to type 'Raw1e18'.
```

Tag the value with `rawShares(...)` and the build passes. That is the whole
migration. Nothing else in the SDK changed shape.

The brand is the point. Before it, a wei balance reached `vault_withdraw.shares`
and type-checked, and the burn was 10^18 times too large. `sharesToWire` and
`VaultWithdraw.shares` now take `NotRaw1e18`, which admits a plain `string` and
a `WholeShares` but refuses a `Raw1e18`. **Every existing caller that passes a
plain string keeps compiling** — the wall fires only where the plane is TAGGED.

Leave the raw plane with `rawSharesToWhole`. It divides in `BigInt`, so the
result is exact at every magnitude; a float divide drops digits past the 15-17
a double holds, and a share count carries 18 fraction digits.

No runtime check can separate the two planes. `'1000000000000000000'` is also a
legal whole-share count, so the separation has to be a compile-time fact.

### The MIP-3 perp deployer lane — nine actions, NOT LIVE YET

`perp_register_asset`, `perp_set_oracle`, `perp_set_leverage`,
`perp_set_fee_tier`, `perp_set_maker_rebate`, `perp_set_min_size`,
`perp_activate_market`, `perp_deactivate_market` and `perp_set_sub_deployers`.

**The nine tags landed in the node but that binary is not released.** The live
chain refuses all nine today, the same way it refuses an action that does not
exist. They start working at the freeze-swap height of the release that carries
them. A signature you build today is correct and arrives early.

All nine are sender-authorized: the recovered signer IS the deployer or one of
its sub-deployers. None carries a `bid` — the gas-auction lane is dead and the
handler rejects a non-zero bid.

A deployer cannot pick the asset id. `perp_register_asset` allocates it, at or
above 1000; the ids below that are the chain's own perps. Read the id back
before calling any of the other eight.

Two governance limits bind the lane, and `0` means UNCAPPED for both, never
blocked: `max_deploys_per_epoch` rate-limits registration across this lane and
both spot lanes together, and `fee_ceiling_bps` bounds the taker and maker legs.
The off-switch is separate — governance sets `mip3_enabled`.

### The MIP-1 spot deployer lane — six actions

`spot_register_token`, `spot_register_pair`, `spot_set_pair_params`,
`spot_set_pair_active`, `spot_seed_holders` and `spot_finalize_supply`.

### `register_metaliquidity_operator`

A Metaliquidity vault's LEADER grants or revokes an operator key that then acts
as the vault. The signer must be the leader, and the vault's kind must be
`Metaliquidity` — the node refuses a `User` vault here.

**Granting also requires the operator to be a recognised MetaLiquidity
Provider.** A key outside that set is refused, so a leader cannot hand
vault-trading authority to an arbitrary address. Revoking has no such
requirement.

**Never send an explicit `expires_at_ms: 0`.** OMIT the key for an operator that
never expires. The node refuses an explicit `0` with a `400`, and the SDK
refuses it before signing. The digest flattens an absent field and an explicit
`0` to the same `uint64 0`, so one leader signature would cover two wire forms
that commit different state: absent means never expires, `0` means expired at
epoch — an operator dead on arrival.

### `borrow_lend`

Move liquidity directly against the BOLE pool. `Lend` adds liquidity and
`UnLend` withdraws it, up to the sender's own lent balance. `Borrow` draws on
the pool's liquidator credit line and `Repay` returns it, up to the sender's
outstanding borrow.

**`Borrow` needs the allowlist.** The node refuses it as `Unauthorized` unless
the sender is a registered liquidator. The other three kinds are open to any
account.

`kind` is PascalCase to match the node's enum, and `UnLend` keeps its capital
`L`.

### Two corrections: the SDK said a live action was dead

Both notes described a refusal the node does not carry. Both actions landed on
the signed `/exchange` path on 2026-06-20 and have been live across every
release since.

- **`send_to_evm_with_data`** — the type said `⚠️ NOT LIVE YET` and quoted a
  400 reading `sendToEvmWithData is retired; use coreEvmTransfer`. No such
  string exists in the node. A caller who believed the note routed around a
  working lane.
- **`vault_distribute`** — the type said the node answers the tag with
  `UnsupportedAction` on the public `/exchange` path. It does not.
  `UnsupportedAction` covers the validator-injected lane only: `vote_global`,
  `gov_vote`, `c_validator`, `set_pm_shock_grid`, `set_mark_mode`,
  `approve_upgrade`, `arm_features` and `vote_app_hash`.

No type or payload changed for either. These entries are documentation.

### Forced-liquidation settlement is wired

The spot-margin comment said it is not. It IS wired, and it runs every block.
What is still pending is governance, not code: no spot pair has its per-pair
risk parameters calibrated, so opening rejects until a vote lands.

## [0.21.0] — 2026-08-17

A new signable action, so this is a minor rather than a patch.

The header here previously read "staged as 0.16.0" while the published package was
already 0.20.0. The two SDK version lines are NOT in step and this entry stops
claiming they are: the Rust SDK is on its own line and is not published to a
registry.

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
