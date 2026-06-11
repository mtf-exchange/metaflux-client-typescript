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
const markets = await client.info.markets();
console.log(markets.map((m) => `${m.name} @ ${m.mark_px}`));

const acct = await client.info.accountState(
  '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025',
);
console.log(acct.account_value, acct.positions);

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

The spot CLOB (v0 = IOC limit only; `limit_px` must be > 0 on the 1e8 price
plane) is a separate book from the perp engine, keyed by a numeric **pair id**.
Discover pairs with `client.info.spotMeta()`, trade with
`submitSpotOrderNative` / `cancelSpotOrderNative`, and read balances back with
`client.info.spotClearinghouseState(address)`:

```ts
// 1. Discover pairs. `name` is derived as "{base}/{quote}" from the token
//    registry; `id` is the numeric pair id.
const spotMeta = await client.info.spotMeta();
const pair = spotMeta.pairs.find((p) => p.name === 'BTC/USDC')!;
// spotMeta.tokens carries per-token decimals (sz_decimals / wei_decimals).

// 2. Place an IOC limit spot order (signed, POST /exchange).
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

// Borrow side: post collateral, then open a leveraged long.
await client.spotMarginDeposit({ pair: pair.id, amount: '100' });
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
  `approveBuilderFee`, `convertToMultiSigUser`, `userDexAbstraction`,
  `userSetAbstraction`, `agentSetAbstraction`, `priorityBid`.
- **Staking**: `tokenDelegate`, `claimRewards`, `linkStakingUser`.
- **Vaults**: `createVault`, `vaultTransfer`, `vaultModify`, `vaultWithdraw`.
- **Spot margin & Earn** (devnet preview): `spotMarginDeposit` /
  `spotMarginWithdraw` / `spotMarginOpen` / `spotMarginClose`, and the lending
  supply side `earnDeposit` / `earnWithdraw`.
- **Encrypted orders**: `submitEncryptedOrder`.
- **MetaBridge**: `mbWithdraw` (cross-collateral withdrawal to another chain).
- **Governance**: `setMetaliquidityWhitelist`, `registerMetaliquidityOperator`.

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

```ts
import { WsClient } from '@metaflux-dex/client';

const ws = new WsClient('ws://localhost:8080/ws');
ws.onMessage((f) => {
  if (f.channel === 'l2_book') handleBook(f.data);
});
await ws.connect();
await ws.subscribe({ type: 'l2_book', coin: 'BTC' });
```

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
