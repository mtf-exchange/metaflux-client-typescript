# @metaflux-dex/client

TypeScript client SDK for the [MetaFlux (MTF)](https://github.com/mtf-exchange) L1.
CPU-heavy work (secp256k1 signing, keccak256, msgpack canonical encoding) is
pushed into a wasm-bindgen WASM module — the pure-TS surface is a thin,
type-safe `fetch` wrapper that speaks the **MTF-native** protocol directly
(`POST /info` reads, `POST /exchange` signed writes, `wss://…/ws` streams).

> MetaFlux-native only. HL-compatible and CCXT endpoints live on the gateway;
> this SDK targets the node/gateway's first-class MTF-native surface.

## Install

```bash
npm install @metaflux-dex/client
```

The published package ships the compiled `dist/` (TypeScript) and `pkg/` (WASM)
artifacts — no Rust toolchain needed to **consume** it. You only need Rust +
`wasm-pack` to build from source (see [Develop](#develop)).

## Quickstart

```ts
import { Client } from '@metaflux-dex/client';

const client = new Client({
  baseUrl: 'http://localhost:8080',
  // Optional. Without a private key the Client is read-only.
  privateKey: new Uint8Array(32).fill(0x42),
});

// ---- Reads (no key required) — POST /info, {type,data} envelope unwrapped ----
// Market reads are keyed by `coin` (the market SYMBOL, e.g. "BTC"); account
// reads by 0x `address`. Numeric market_id/asset_id/account_id params are gone
// from the read surface (the signed /exchange action plane keeps numeric ids).
const markets = await client.info.markets(); // { perp: MarketInfo[], spot: SpotMeta }
console.log(markets.perp.map((m) => `${m.coin} @ ${m.mark_px}`));

// Per-market margin ladder is inline on markets / market_info as margin_tiers
// (upper-bound OI bands; the top band has max_open_interest: null).
const btc = await client.info.marketInfo('BTC');
console.log(btc.margin_tiers);

const book = await client.info.l2Book('BTC');
const trades = await client.info.tradesByTime('BTC', Date.now() - 3_600_000);
const funding = await client.info.predictedFundings();
const bars = await client.info.candleSnapshot('BTC', '1m'); // { candles: [...] }
console.log(book.bids.length, trades.trades.length, funding.length, bars.candles.length);

const acct = await client.info.accountState(
  '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025',
);
// Positions are grouped by perp dex; the core dex key is the empty string.
console.log(acct.account_value, acct.clearinghouse_state['']?.positions);

// ---- Signed order — POST /exchange (MTF-native signed action) ----
const ack = await client.submitOrderNative({
  owner: '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025', // must equal the signer
  market: 0, // BTC perp (asset id)
  side: 'bid', // 'bid' = buy, 'ask' = sell
  kind: 'limit',
  size: 1_000, // fixed-point tick units
  limit_px: 5_000_000_000_000, // fixed-point tick units
  tif: 'gtc', // 'gtc' | 'ioc' | 'aon' | 'alo'
  stp_mode: 'cancel_newest',
  reduce_only: false,
});

// Synchronous per-order status — the oid is assigned at admission.
// statuses[i] is one of { resting:{oid} } | { filled:{oid,total_sz,avg_px} } | { error }
console.log(ack.statuses?.[0]);
```

The signing flow (EIP-712 over the canonical action bytes, nonce auto-assigned,
`chainId` defaults to `MTF_CHAIN_ID` = MTF testnet `114514`; mainnet is `8964`,
exported as `MTF_TESTNET_CHAIN_ID` / `MTF_MAINNET_CHAIN_ID`) is handled inside
`submitOrderNative`. The
recovered signer is checked against `owner` locally before the request leaves the
process. Cancel via `client.cancelOrderNative({ … })`.

### One entry point: `placeOrder`

`submitOrderNative` / `batchOrder` / `submitSpotOrderNative` each reach one wire
action directly. `placeOrder` is a convenience over them: tag each order with its
`venue` and it picks the action for you. The tag is a discriminated union, so a
perp-only field on a spot order is a compile error.

```ts
// All-perp, any count -> ONE `batch_order`. The node answers with one status
// per placed leg, each echoing that leg's own cloid.
const perp = await client.placeOrder([
  { venue: 'perp', owner, market: 0, side: 'bid', kind: 'limit',
    size: 1_000, limit_px: 5_000_000_000_000, tif: 'gtc',
    stp_mode: 'cancel_newest', reduce_only: false },
  { venue: 'perp', owner, market: 1, side: 'ask', kind: 'limit',
    size: 500, limit_px: 300_000_000_000, tif: 'alo',
    stp_mode: 'cancel_newest', reduce_only: true },
]);
if (perp.route === 'batch_order') {
  for (const leg of perp.legs) console.log(leg.index, leg.status);
}

// All-spot -> ONE `spot_order` action PER order. `batch_order` legs are perp
// orders, so the wire CANNOT batch spot: these are N independent submissions
// with N nonces, and `submissions` reports each one separately.
// `opts.owner` rides BOTH routes: the perp route puts it on the batch_order top
// level, the spot route on every leg that omits its own `owner`.
const spot = await client.placeOrder(
  [
    { venue: 'spot', pair: pair.id, side: 'bid', size: 10,
      limit_px: 200_000_000, tif: 'ioc', stp_mode: 'cancel_oldest' },
  ],
  { owner },
);
if (spot.route === 'spot_order') {
  for (const s of spot.submissions) console.log(s.index, s.state);
}

// MIXED perp and spot -> REJECTED. Two venues have no single wire action, and a
// silent split would give you two independent submissions where you expect one.
// A spot action that fails stops the run and throws `PlaceOrderPartialError`,
// which carries the same per-action record — the earlier ones were sent.

// Dry run: see the exact bytes that would be signed, without signing.
import { planPlaceOrder } from '@metaflux-dex/client';
const plan = planPlaceOrder([{ venue: 'perp', owner, market: 0, /* … */ }]);
console.log(plan.route, plan.actionJson);
```

`placeOrder` converts nothing between number planes: `limit_px` stays on the 1e8
book plane and `size` stays in raw lots, exactly as you pass them.

Other native actions share the same signed-action envelope but are
sender-authorized (the signer is the actor, so there is no `owner` to check):

```ts
// Hedge mode: switch the account to two-way (only legal while flat).
await client.setPositionMode({ hedge: true });
// Perp orders on a hedge account then carry an optional position_side:
//   submitOrderNative({ owner, market, …, position_side: 'long' })
// One-way accounts omit it (the default), keeping the signed bytes identical.
```

### Spot trading

The spot CLOB is a separate book from the perp engine, keyed by a numeric **pair
id**. Prices ride the 1e8 plane. All three time-in-force values work: `ioc` drops
the residual, `gtc` and `alo` rest it with escrow. Discover pairs with
`client.info.spotMeta()`, trade with `submitSpotOrderNative` /
`cancelSpotOrderNative`, and read balances back with
`client.info.spotClearinghouseState(address)`.

Both spot actions take an optional `owner`. Set it and an **approved agent** of
that account places or cancels AS the owner; leave it off and the signer trades
for itself:

```ts
// 1. Discover pairs. `name` is derived as "{base}/{quote}" from the token
//    registry; `id` is the numeric pair id.
const spotMeta = await client.info.spotMeta();
const pair = spotMeta.pairs.find((p) => p.name === 'BTC/USDC')!;
// spotMeta.tokens carries per-token decimals (sz_decimals / wei_decimals).

// 2. Place an IOC limit spot order (signed, POST /exchange). Add
//    `owner: '0x…'` to place it as an account this key is an approved agent of.
const spotAck = await client.submitSpotOrderNative({
  pair: pair.id,
  side: 'bid',
  size: 10,
  limit_px: 200_000_000, // 1e8 price plane
  tif: 'ioc',
  stp_mode: 'cancel_oldest',
});

// 3. Read balances back.
const spotBals = await client.info.spotClearinghouseState(
  '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025',
);
for (const b of spotBals.balances) console.log(b.name, b.asset, b.balance);

// 4. Cancel a resting order by oid.
await client.cancelSpotOrderNative({ pair: pair.id, oid: 7 });
```

On the WebSocket `trades` / `candles` / `fills` channels, spot prints carry the
**numeric pair id** as the `coin` label (e.g. `"101"`), not the display name —
use `spotMeta()` to map `id` to its `"{base}/{quote}"` name.

### Spot margin & Earn (devnet preview)

Leveraged spot borrows quote (USDC) from the **Earn** lending pool. It is
**available on devnet (preview)**: the full deposit → borrow → leveraged-buy →
close loop works, but forced-liquidation settlement is not yet wired and per-pair
maintenance ratios are still being calibrated — don't treat it as production-ready.
All six actions are **sender-authorized** (the signer is the actor) and return the
`202 Accepted` admission ack, not a synchronous `oid`; observe committed state by
posting `/info` `spot_margin_state` / `earn_state`. Decimal amounts (`amount` /
`borrow` / `shares`) are passed as **strings**; `size` / `limit_px` are integers
on the raw-lot / 1e8 planes.

```ts
// Supply side: a lender funds the pool (asset = the pair's quote token id).
await client.earnDeposit({ asset: pair.quote, amount: '5000' });

// Borrow side: open a leveraged long. Margin is CROSS-collateralized against
// your one unified USDC account, so there is nothing to post per pair.
// `spotMarginDeposit` / `spotMarginWithdraw` are DEAD: the node rejects both
// while cross-margin is active, which on the live chain is from genesis.
await client.spotMarginOpen({
  pair: pair.id,
  size: 200,
  limit_px: 200_000_000,
  borrow: '400',
});

// Read the position over POST /info { type: 'spot_margin_state', user }, then
// close it (sells the held base, repays principal + interest, returns the rest).
await client.spotMarginClose({ pair: pair.id, limit_px: 200_000_000 });

// Lender exits — clamped to idle liquidity (supplied − borrowed).
await client.earnWithdraw({ asset: pair.quote, shares: '1234.5' });
```

### More native actions

The Client exposes the rest of the MTF-native signed-action surface, all via the
same `{ action, nonce, signature }` → `POST /exchange` envelope. **Owner-checked**
actions carry an actor field (`leader` / `user` / `taker` / `owner` / `sender` /
`submitter`) that must equal the signing wallet (checked locally before the
request leaves the process); **sender-authorized** actions have no such field —
the recovered signer is the actor.

All of these are **sender-authorized** (the recovered signer is the actor) except
`submitOrderNative` / `cancelOrderNative`, and `batchOrder` / `batchCancel` whose
inner orders / cancels each carry an `owner` the client checks against the signer.

- **Order management**: `cancelByCloid`, `modify`, `batchModify`, `batchOrder` /
  `batchCancel`, `scheduleCancel`, `cancelAllOrders`.
- **TWAP**: `twapOrder` / `twapCancel`.
- **Leverage & margin**: `updateLeverage`, `updateIsolatedMargin`,
  `topUpIsolatedOnlyMargin`, `userPortfolioMargin` (portfolio-margin enroll).
- **Account & agents**: `setDisplayName`, `setReferrer`, `approveAgent`,
  `approveBuilderFee`, `convertToMultiSigUser`, `userSetAbstraction`,
  `agentSetAbstraction`, `priorityBid`.
- **Staking**: `tokenDelegate`, `claimRewards`, `linkStakingUser`.
- **Vaults**: `createVault`, `vaultTransfer`, `vaultModify`, `vaultWithdraw`.
- **Spot margin & Earn** (devnet preview): `spotMarginDeposit` /
  `spotMarginWithdraw` / `spotMarginOpen` / `spotMarginClose`, and the lending
  supply side `earnDeposit` / `earnWithdraw`.
- **Encrypted orders**: `submitEncryptedOrder`.
- **MetaBridge**: `mbWithdraw` (cross-collateral withdrawal to another chain).

Decimal magnitudes (`amount` / `delta` / `shares` / `value`) are passed as
**strings**; ids / sizes / prices are plain integers.

```ts
const me = '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025'; // the signing wallet

// Vault — the signing wallet becomes the leader.
await client.createVault({ name: 'my-vault', lock_period_secs: 4 * 86_400 });
// Follower redeems shares (decimal string).
await client.vaultWithdraw({ vault_id: 7, shares: '250.5' });

// Leverage / margin.
await client.updateLeverage({ asset: 0, leverage: 10, is_isolated: false });
await client.updateIsolatedMargin({ asset: 0, delta: '-12.5' });
await client.userPortfolioMargin({ enroll: true });

// TWAP — slice a large order over time.
await client.twapOrder({
  market: 0,
  side: 'bid',
  total_size: 10_000,
  slice_count: 10,
  delay_ms: 500,
  reduce_only: false,
});

// Staking.
await client.tokenDelegate({ validator: me, amount: '100.5', is_undelegate: false });

// MetaBridge — withdraw cross-collateral to another chain.
await client.mbWithdraw({ chain: 'Base', asset: 0, amount: 1_000_000, dst_addr: me });

// Encrypted order — `ciphertext` + 32-byte `commitment` are raw bytes; the SDK
// emits them as serde byte arrays.
await client.submitEncryptedOrder({
  ciphertext: new Uint8Array([0xab, 0xcd, 0xef]),
  commitment: new Uint8Array(32),
  threshold: 5,
  target_block: 1_000_000,
  reveal_deadline_ms: 5_000,
});
```

Each method takes an optional `{ nonce?, chainId? }` and returns the same
`NativeExchangeAck`. The matching `buildNative*Action` builders are exported for
out-of-band signing.

### WebSocket streams

The gateway serves 22 native snake_case channels: `l2_book`, `bbo`, `trades`,
`active_asset_ctx`, `all_mids`, `markets`, `explorer_block`, `explorer_txs`,
`candles`, `fills`, `user_events`, `order_updates`, `open_orders`,
`notifications`, `ledger_updates`, `user_fundings`, `user_twap_slice_fills`,
`user_twap_history`, `account_state`, `web_data`, `spot_margin_state`, and
`active_asset_data`. Per-market channels take `coin` (the market symbol);
per-account channels take `user` (0x address).

`web_data2` and `spot_state` were both removed. Compose `account_state` +
`web_data` instead. The REST `spot_clearinghouse_state` read still works, but
note that `account_state.balances` skips an all-zero token row, which
`spot_state` used to emit.

Each frame carries an `is_snapshot` flag: `true` marks an on-subscribe full
snapshot, `false` or absent marks a delta. The `candles` channel is the
exception — read the `snapshot` flag inside its body instead.

Every channel has a body type. `isChannelFrame` narrows a frame to one channel
and types its `data`, so the compiler checks each field you read.

```ts
import { WsClient, isChannelFrame } from '@metaflux-dex/client';

const ws = new WsClient('ws://localhost:8080/ws');
ws.onMessage((f) => {
  // `f.data` is WsL2Book here — levels[0] is bids, levels[1] is asks.
  if (isChannelFrame(f, 'l2_book')) handleBook(f.data.levels);
  if (isChannelFrame(f, 'trades')) {
    // On-subscribe snapshot is a NON-EMPTY array of recent prints with
    // users: null; live pushes carry users: [taker, maker].
    for (const t of f.data) console.log(t.coin, t.px, t.sz);
  }
});
await ws.connect();
await ws.subscribeTrades('BTC');
await ws.subscribe({ type: 'l2_book', coin: 'BTC' }); // same thing, explicit form
await ws.subscribeExplorerTxs(); // global tx tape; rows carry the action hash
```

`WsChannelData` maps each channel name to its body type. Read it for the full
list; the notes below cover the shapes that most often surprise people.

- `user_fundings` records are `{coin, usdc, szi, funding_rate, time}`. `coin` is
  the market SYMBOL and `usdc` is the signed payment — the SAME key the REST
  `user_funding` history uses, so you can seed from REST and merge live deltas.
- `active_asset_ctx` nests every metric under `ctx`: `{coin, ctx: {mark_px,
  oracle_px, mid_px?, premium, day_ntl_vlm, prev_day_px, change_24h, funding,
  open_interest, px_stale?}}`.
- `l2_book` carries `{coin, levels: [bids, asks], time}` and spells the
  per-level order count `n`. The REST `l2_book` read instead returns flat
  `bids` / `asks` and spells that count `n_orders`.
- `candles` on a gateway is `{snapshot, candles}` of REST `Candle` bars. A
  node-direct mount sends a bare array of `WsNodeCandle` instead. Narrow with
  `Array.isArray`.
- `markets` pushes an array of `WsMarketRow` — DYNAMIC per-market state. It is
  not the REST `markets` read, which returns static definitions.
- The two TWAP channels keep camelCase keys (`twapId`, `executedSz`,
  `reduceOnly`). That is the server contract, not a defect.
- On `order_updates`, a `filled` record carries the cumulative `filled_sz` +
  `avg_px` while `order.orig_sz` is the original size and `order.sz` the
  post-fill remainder; on a MAKER record `filled_sz` is THIS match's size, not
  the cumulative amount. The inner `order` is the SAME canonical row the REST
  `open_orders` read returns.

### Power-user exports

The barrel also exports the low-level pieces so you can build custom flows —
`InfoApi` (standalone read client), a `buildNative*Action` builder for every
signed action (`buildNativeOrderAction`, `buildNativeCreateVaultAction`,
`buildNativeUpdateLeverageAction`, `buildNativeMbWithdrawAction`, … — one per
method above), the `signNativeAction` / `nativeActionDigest` signing core, and
the WASM crypto primitives (`keccak256`, `signSecp256k1`, `recoverPubkey`, …).
See [`src/index.ts`](src/index.ts) for the full surface.

## What's WASM-backed vs pure-TS

| Operation                          | Layer                                    |
| ---------------------------------- | ---------------------------------------- |
| keccak256 (any input length)       | WASM (`sha3::Keccak256`)                 |
| secp256k1 sign / recover / verify  | WASM (`k256` 0.13.x)                     |
| EIP-712 envelope hash composition  | WASM (single keccak call, fewer FFI hops)|
| msgpack encoding of action bodies  | WASM (`rmp_serde::to_vec_named`)         |
| EVM address derivation             | WASM (keccak + low-20-bytes slice)       |
| HTTP fetch wrapper                 | TS                                       |
| `{type,data}` envelope unwrap      | TS                                       |
| JSON request/response coercion     | TS                                       |
| WebSocket framing + reconnect      | TS                                       |

The split is intentional: every byte the gateway/node *parses* is produced by
Rust on both sides. The TS layer only assembles JSON envelopes around
already-canonical WASM outputs, so the wire format has a single source of truth.

## Wire conventions

- **Signature**: 65-byte recoverable ECDSA, `r (32) || s (32) || v (1)`, where
  `v` is the raw recovery id (0 or 1).
- **EIP-712 digest**: `keccak256(0x1901 || domain_separator || message_hash)`,
  `domain = { name: "MetaFlux", version: "1", chainId, verifyingContract: 0x0 }`
  (`chainId` = testnet `114514` by default, mainnet `8964`).
- **MTF-native action**: a canonical snake_case JSON action
  (`{"type":"submit_order","order":{…}}`) signed verbatim; the request body is
  `{ action, nonce, signature }` to `POST /exchange`.

Field shapes are mirrored from the authoritative API spec in
[`metaflux-knowledges`](https://github.com/mtf-exchange/metaflux-knowledges).

## Develop

This repo uses [pnpm](https://pnpm.io) (see `packageManager` in package.json).

```bash
# Rust toolchain + wasm-pack (to build the WASM module).
brew install rust wasm-pack

pnpm install
pnpm build         # wasm-pack -> pkg/, then tsc -> dist/
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
```

Build the artifacts separately with `pnpm build:wasm` / `pnpm build:ts`.

## Repository layout

```
.
├── package.json              # @metaflux-dex/client
├── src/
│   ├── index.ts              # public barrel
│   ├── client.ts             # Client class — reads + signed writes
│   ├── faucet.ts             # devnet/testnet faucet helper
│   ├── rest/
│   │   ├── http.ts           # fetch wrapper + MetaFluxApiError
│   │   └── info.ts           # InfoApi — POST /info read methods
│   ├── ws/
│   │   └── ws.ts             # WsClient — subscriptions + reconnect
│   ├── wallet/
│   │   └── wasm.ts           # WASM loader + typed crypto wrappers
│   ├── native/
│   │   ├── digest.ts         # signing core — digest / sign / recover / nonce
│   │   └── actions.ts        # build*Action canonical-JSON builders
│   └── types/
│       ├── index.ts          # type re-export barrel
│       ├── trading.ts        # Order / NativeOrder / acks / shared enums
│       ├── spot.ts           # NativeSpotOrder / NativeSpotCancel + spot-margin / Earn
│       ├── vault.ts          # vault action payloads
│       ├── pm.ts             # portfolio-margin action payloads
│       ├── rfq.ts            # RFQ action payloads
│       ├── fba.ts            # frequent-batch-auction action payload
│       ├── cross-chain.ts    # cross-chain action payload
│       ├── encrypted.ts      # encrypted-order action payload
│       └── info/             # /info response shapes ({type,data}.data)
│           ├── index.ts      # re-export barrel
│           ├── core.ts       # node / account / market / vault / staking / fee
│           ├── reads.ts      # book / trade / account-history reads
│           └── hl-parity.ts  # HL-node parity query shapes
├── __tests__/                # vitest: actions / info / native / sign / ws
├── wasm/                     # standalone wasm-bindgen crate (+ native tests)
├── pkg/                      # wasm-pack output (gitignored)
└── dist/                     # tsc output (gitignored)
```

## License

[MIT](LICENSE) © MetaFlux
