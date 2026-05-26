# @metaflux/client

TypeScript client SDK for the MetaFlux (MTF) L1, targeted at the
MetaFlux web app. CPU-heavy work (secp256k1 signing, keccak256, msgpack
canonical encoding) is pushed into a wasm-bindgen WASM module — the
pure-TS surface is a thin, type-safe fetch wrapper.

## Quickstart

### One-time install

```bash
# Rust toolchain + wasm-pack (for building the WASM module).
brew install rust wasm-pack

# npm deps.
npm install
```

### Build

```bash
# Compiles the WASM crate then the TypeScript.
# Both artifacts go in dist/ + pkg/ at the repo root.
npm run build
```

You can also run the steps separately:

```bash
npm run build:wasm   # cargo + wasm-pack -> pkg/
npm run build:ts     # tsc              -> dist/
```

### Test

```bash
npm test                  # vitest, exercises the WASM surface
cd wasm && cargo test     # native-target rust tests for the same primitives
```

## Example usage

```ts
import { Client, type Order } from '@metaflux/client';

const client = new Client({
  baseUrl: 'http://localhost:8080',
  // Optional. Without a private key, the Client is read-only.
  privateKey: new Uint8Array(32).fill(0x42),
});

// Read-only.
const markets = await client.getMarkets();
console.log(markets.map((m) => m.symbol));

// Sign + submit an order.
const order: Order = {
  asset: 0,
  side: 0,                     // 0 = buy, 1 = sell
  sizeE8: 100_000_000n,        // 1.0 base units (scaled by 1e8)
  priceE8: 5_000_000_000_000n, // 50000.0 quote per base
  tif: 0,                      // 0 = GTC, 1 = IOC, 2 = ALO
};
const signed = await client.signOrder(order);
const ack = await client.submitOrder(signed);
console.log('Order ID:', ack.id);
```

## What's WASM-backed vs pure-TS

| Operation                          | Layer                                    |
| ---------------------------------- | ---------------------------------------- |
| keccak256 (any input length)       | WASM (`sha3::Keccak256`)                 |
| secp256k1 sign / recover / verify  | WASM (`k256` 0.13.x)                     |
| EIP-712 envelope hash composition  | WASM (single keccak call, fewer FFI hops)|
| msgpack encoding of action bodies  | WASM (`rmp_serde::to_vec_named`)         |
| EVM address derivation             | WASM (keccak + low-20-bytes slice)       |
| HTTP fetch wrapper                 | TS                                       |
| JSON request/response coercion     | TS                                       |
| URL/query-string composition       | TS                                       |
| Base64 / hex encoding for wire     | TS                                       |
| Type validation (address format)   | TS                                       |
| JWT bookkeeping                    | TS                                       |

The split is intentional: every byte that the gateway/node *parses* is
produced by Rust running on either side. The TS layer only assembles
JSON envelopes around already-canonical WASM outputs, so the wire
format has a single source of truth.

## Wire conventions (mirrors the main repo)

- **Signature**: 65-byte recoverable ECDSA, `r (32) || s (32) || v (1)`.
  `v` is the raw recovery id (0 or 1) — the gateway converts to the
  EVM `v + 27` convention if it needs to. Source: `consensus/src/signing.rs`
  in the main metaflux repo.
- **EIP-712 digest**: `keccak256(0x1901 || domain_separator || message_hash)`
  with `domain = { name: "MetaFlux", version: "1", chainId: <client opt>, verifyingContract: Address::ZERO }`.
  Source: `core-state/src/signing.rs`.
- **Order body**: msgpack-encoded `{ asset, side, px, size, tif }` with
  named fields. Source: `core-state/src/actions/trading.rs::OrderParams`.

## Repository layout

```
.
├── package.json              # @metaflux/client v0.0.1
├── tsconfig.json             # strict ES2022 ESM
├── vitest.config.ts          # test runner config
├── src/
│   ├── index.ts              # public barrel
│   ├── client.ts             # Client class — main surface
│   ├── wasm.ts               # WASM loader + typed wrappers
│   ├── http.ts               # fetch wrapper + MetaFluxApiError
│   └── types.ts              # Order / SignedOrder / Market / Position
├── __tests__/
│   └── sign.test.ts          # vitest — skips when pkg/ is missing
├── wasm/
│   ├── Cargo.toml            # standalone crate, NOT a workspace member
│   └── src/lib.rs            # wasm-bindgen exports + 15 native tests
├── pkg/                      # wasm-pack output (gitignored)
└── dist/                     # tsc output (gitignored)
```

## TODO

- `getTicker(symbol)`, `getOrderBook(symbol, limit?)`, `getOhlcv(...)`
  for the rest of the CCXT minimal subset.
- `/ccxt/auth` JWT bootstrap — currently the Client carries an optional
  JWT but does not auto-mint one from an EIP-712 envelope. Plumbing
  lands alongside the gateway's auth endpoint integration.
- `cancelOrder(id)` / `cancelByCloid(cloid)`.
- WebSocket client for `watchTicker` / `watchOrderBook` / `watchTrades`.
- WASM-target test runner (`wasm-pack test --headless --chrome`) — the
  current native tests cover the wire format, but the WASM ABI itself
  is exercised only via the vitest suite once `pkg/` is built.
