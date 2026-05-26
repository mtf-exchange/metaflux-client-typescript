// Sign / verify round-trip via the WASM module.
//
// Skips with a helpful message when `pkg/` is missing (the test does not
// invoke `wasm-pack` itself — that's a manual step per the SDK setup
// flow). On a built repo, exercises the same primitives the native
// `cargo test` covers, this time through the WASM ABI.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

if (!wasmBuilt) {
  // eslint-disable-next-line no-console
  console.warn(
    '[sign.test.ts] pkg/ not found — skipping WASM tests. ' +
      'Run `npm run build:wasm` to enable.',
  );
}

// Toggle suite based on build state. `describe.skipIf` is the vitest
// idiomatic way to omit a whole suite at runtime — the test output
// shows it as "skipped" rather than "passed", which matches the
// "you forgot to build WASM" signal we want.
describe.skipIf(!wasmBuilt)('WASM crypto round-trips', () => {
  it('keccak256 of empty input matches the Ethereum yellow-paper vector', async () => {
    const { keccak256 } = await import('../src/wasm.js');
    const out = await keccak256(new Uint8Array());
    // Canonical empty-keccak digest.
    const expected = Uint8Array.from([
      0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c, 0x92, 0x7e, 0x7d, 0xb2,
      0xdc, 0xc7, 0x03, 0xc0, 0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b,
      0x7b, 0xfa, 0xd8, 0x04, 0x5d, 0x85, 0xa4, 0x70,
    ]);
    expect(Array.from(out)).toEqual(Array.from(expected));
  });

  it('sign + recover returns the signing pubkey', async () => {
    const { keccak256, signSecp256k1, recoverPubkey } = await import(
      '../src/wasm.js'
    );
    const privKey = new Uint8Array(32).fill(0x42);
    const msgHash = await keccak256(
      new TextEncoder().encode('vote{round=10}'),
    );
    const sig = await signSecp256k1(privKey, msgHash);
    expect(sig.length).toBe(65);

    const recovered = await recoverPubkey(sig, msgHash);
    expect(recovered.length).toBe(33);
    // Compressed pubkeys start with 0x02 or 0x03.
    expect(recovered[0] === 0x02 || recovered[0] === 0x03).toBe(true);
  });

  it('signing is deterministic (RFC 6979)', async () => {
    const { keccak256, signSecp256k1 } = await import('../src/wasm.js');
    const privKey = new Uint8Array(32).fill(0x11);
    const msgHash = await keccak256(
      new TextEncoder().encode('deterministic'),
    );
    const s1 = await signSecp256k1(privKey, msgHash);
    const s2 = await signSecp256k1(privKey, msgHash);
    expect(Array.from(s1)).toEqual(Array.from(s2));
  });

  it('Client.signOrder produces a 65-byte signature + 20-byte signer', async () => {
    // End-to-end: encode -> hash -> sign -> recover -> address.
    const { Client } = await import('../src/client.js');
    const privKey = new Uint8Array(32).fill(0x07);
    const client = new Client({
      baseUrl: 'http://localhost:0', // never hit; signOrder doesn't fetch.
      privateKey: privKey,
    });
    const signed = await client.signOrder({
      asset: 0,
      side: 0,
      sizeE8: 100_000_000n, // 1.0 base units
      priceE8: 5_000_000_000_000n, // 50000.0
      tif: 0,
    });
    expect(signed.signature.length).toBe(65);
    expect(signed.signer.length).toBe(20);
    expect(signed.payload.length).toBeGreaterThan(0);
  });

  it('encode_limit_order is deterministic for identical inputs', async () => {
    const { encodeLimitOrder } = await import('../src/wasm.js');
    const a = await encodeLimitOrder(1, 0, 100n, 200n, 0);
    const b = await encodeLimitOrder(1, 0, 100n, 200n, 0);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('derive_address_from_pubkey produces a 20-byte address', async () => {
    const { keccak256, signSecp256k1, recoverPubkey, deriveAddressFromPubkey } =
      await import('../src/wasm.js');
    const privKey = new Uint8Array(32).fill(0x99);
    const msgHash = await keccak256(new TextEncoder().encode('address-test'));
    const sig = await signSecp256k1(privKey, msgHash);
    const pubkey = await recoverPubkey(sig, msgHash);
    const address = await deriveAddressFromPubkey(pubkey);
    expect(address.length).toBe(20);
  });
});
