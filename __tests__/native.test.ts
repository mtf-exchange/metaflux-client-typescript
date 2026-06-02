// MTF-native signed-action digest — cross-impl known-answer + round-trips.
//
// Pins the TS digest to the SAME value the Rust SDK + server commit to for a
// fixed (action_json, nonce, chainId) input. If this drifts, the TS SDK is
// signing a different digest than the server verifies and every order 401s.

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
    '[native.test.ts] pkg/ not found — skipping WASM tests. ' +
      'Run `npm run build:wasm` to enable.',
  );
}

// EXACT bytes the server hashed in its KAT vector
// (metaflux/crates/core-state/src/signing.rs::native_action_kat_vector).
const KAT_ACTION_JSON =
  '{"type":"submit_order","order":{"owner":"0x000000000000000000000000000000000000beef","market":1,"side":"bid","kind":"limit","size":1000,"limit_px":5000000000000,"tif":"gtc","stp_mode":"cancel_oldest","reduce_only":false}}';
const KAT_NONCE = 1_700_000_000_000n;
const KAT_CHAIN_ID = 998;
const KAT_DIGEST =
  'bc1fa314ad46f9aa0b146623144ef6f7efff7d43a8998d7bf63ef018c21352f2';

// Cancel KAT — independently derived from the server's `native_action_digest`
// algorithm (keccak256(0x1901 || domainSep5(998) || structHash)) over the EXACT
// cancel_order action bytes the TS builder emits. Pins the cancel path to the
// same digest the server verifies; drift here 401s every cancel.
const CANCEL_KAT_ACTION_JSON =
  '{"type":"cancel_order","cancel":{"owner":"0x000000000000000000000000000000000000beef","market":3,"oid":42}}';
const CANCEL_KAT_DIGEST =
  'c72482a8bb38728c5f91e84191a0a9f562efb71368fd45f60a759066bd628bf2';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

describe.skipIf(!wasmBuilt)('MTF-native signed-action digest', () => {
  it('matches the cross-impl KAT digest for the fixed reference input', async () => {
    const { nativeActionDigest } = await import('../src/native.js');
    const digest = await nativeActionDigest(
      KAT_ACTION_JSON,
      KAT_NONCE,
      KAT_CHAIN_ID,
    );
    expect(toHex(digest)).toBe(KAT_DIGEST);
  });

  it('buildNativeOrderAction reproduces the KAT action bytes exactly', async () => {
    const { buildNativeOrderAction } = await import('../src/native.js');
    const actionJson = buildNativeOrderAction({
      owner: '0x000000000000000000000000000000000000beef',
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
    });
    expect(actionJson).toBe(KAT_ACTION_JSON);
  });

  it('built action + digest agrees with the KAT (end-to-end)', async () => {
    const { buildNativeOrderAction, nativeActionDigest } = await import(
      '../src/native.js'
    );
    const actionJson = buildNativeOrderAction({
      owner: '0x000000000000000000000000000000000000beef',
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
    });
    const digest = await nativeActionDigest(actionJson, KAT_NONCE, KAT_CHAIN_ID);
    expect(toHex(digest)).toBe(KAT_DIGEST);
  });

  it('sign → recover round-trips to the signing address', async () => {
    const { signNativeAction, recoverNativeSigner, buildNativeOrderAction } =
      await import('../src/native.js');
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wasm.js');

    const privKey = new Uint8Array(32).fill(0x42);
    // Derive the signer's own address to use as owner.
    const probeDigest = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probeDigest);
    const probePub = await recoverPubkey(probeSig, probeDigest);
    const ownerBytes = await deriveAddressFromPubkey(probePub);
    const owner = `0x${toHex(ownerBytes)}`;

    const actionJson = buildNativeOrderAction({
      owner,
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
    });
    const signed = await signNativeAction(privKey, actionJson, 1n, KAT_CHAIN_ID);
    expect(signed.signature.startsWith('0x')).toBe(true);
    expect(signed.signature.length).toBe(2 + 130); // 0x + 65 bytes
    expect(signed.actionJson).toBe(actionJson); // sent == signed

    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('digest is sensitive to nonce and chainId', async () => {
    const { nativeActionDigest } = await import('../src/native.js');
    const base = await nativeActionDigest(KAT_ACTION_JSON, KAT_NONCE, 998);
    const otherNonce = await nativeActionDigest(
      KAT_ACTION_JSON,
      KAT_NONCE + 1n,
      998,
    );
    const otherChain = await nativeActionDigest(
      KAT_ACTION_JSON,
      KAT_NONCE,
      31337,
    );
    expect(toHex(base)).not.toBe(toHex(otherNonce));
    expect(toHex(base)).not.toBe(toHex(otherChain));
  });

  it('buildNativeCancelAction reproduces the cancel KAT bytes exactly', async () => {
    const { buildNativeCancelAction } = await import('../src/native.js');
    const actionJson = buildNativeCancelAction({
      owner: '0x000000000000000000000000000000000000beef',
      market: 3,
      oid: 42,
    });
    expect(actionJson).toBe(CANCEL_KAT_ACTION_JSON);
  });

  it('cancel action digest matches the cross-impl cancel KAT', async () => {
    const { buildNativeCancelAction, nativeActionDigest } = await import(
      '../src/native.js'
    );
    const actionJson = buildNativeCancelAction({
      owner: '0x000000000000000000000000000000000000beef',
      market: 3,
      oid: 42,
    });
    const digest = await nativeActionDigest(actionJson, KAT_NONCE, KAT_CHAIN_ID);
    expect(toHex(digest)).toBe(CANCEL_KAT_DIGEST);
  });

  it('cancel sign → recover round-trips to the signing address', async () => {
    const { signNativeAction, recoverNativeSigner, buildNativeCancelAction } =
      await import('../src/native.js');
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wasm.js');

    const privKey = new Uint8Array(32).fill(0x42);
    const probeDigest = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probeDigest);
    const probePub = await recoverPubkey(probeSig, probeDigest);
    const ownerBytes = await deriveAddressFromPubkey(probePub);
    const owner = `0x${toHex(ownerBytes)}`;

    const actionJson = buildNativeCancelAction({ owner, market: 3, oid: 42 });
    const signed = await signNativeAction(privKey, actionJson, 9n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('cancel without oid or cloid throws', async () => {
    const { buildNativeCancelAction } = await import('../src/native.js');
    expect(() =>
      buildNativeCancelAction({
        owner: '0x000000000000000000000000000000000000beef',
        market: 3,
      }),
    ).toThrow();
  });

  it('nativeRequestBody embeds the action bytes verbatim', async () => {
    const { signNativeAction, nativeRequestBody } = await import(
      '../src/native.js'
    );
    const privKey = new Uint8Array(32).fill(0x07);
    const signed = await signNativeAction(
      privKey,
      KAT_ACTION_JSON,
      42n,
      KAT_CHAIN_ID,
    );
    const body = nativeRequestBody(signed);
    // The exact signed action substring must appear unmodified in the body.
    expect(body.includes(`"action":${KAT_ACTION_JSON}`)).toBe(true);
    expect(body.includes('"nonce":42')).toBe(true);
    expect(body.includes(`"signature":"${signed.signature}"`)).toBe(true);
    // And the whole thing must be valid JSON whose action re-parses equal.
    const parsed = JSON.parse(body) as {
      action: unknown;
      nonce: number;
      signature: string;
    };
    expect(parsed.nonce).toBe(42);
    expect(JSON.parse(KAT_ACTION_JSON)).toEqual(parsed.action);
  });
});
