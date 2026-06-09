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
// MTF testnet chain id (114514) — the SDK default. The KAT digests below are
// recomputed for this id; 998 (HL testnet) was retired to avoid a collision.
const KAT_CHAIN_ID = 114514;
const KAT_DIGEST =
  'f7aa1087f79b30fb3f13a190636d32b32720d5984191992d707e2afbca716e0d';

// Cancel KAT — independently derived from the server's `native_action_digest`
// algorithm (keccak256(0x1901 || domainSep5(114514) || structHash)) over the
// EXACT cancel_order action bytes the TS builder emits. Pins the cancel path to
// the same digest the server verifies; drift here 401s every cancel.
const CANCEL_KAT_ACTION_JSON =
  '{"type":"cancel_order","cancel":{"owner":"0x000000000000000000000000000000000000beef","market":3,"oid":42}}';
const CANCEL_KAT_DIGEST =
  'f44e41aeb63b49e4877d948b609d615815851f0c3ff036a42bc0567a125e4d80';

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
    const base = await nativeActionDigest(
      KAT_ACTION_JSON,
      KAT_NONCE,
      KAT_CHAIN_ID,
    );
    const otherNonce = await nativeActionDigest(
      KAT_ACTION_JSON,
      KAT_NONCE + 1n,
      KAT_CHAIN_ID,
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

  // ---- hedge-mode position_side on the perp order ----

  it('one-way order omits position_side (byte-identical to pre-hedge)', async () => {
    const { buildNativeOrderAction } = await import('../src/native.js');
    const base = {
      owner: '0x000000000000000000000000000000000000beef',
      market: 1,
      side: 'bid' as const,
      kind: 'limit' as const,
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc' as const,
      stp_mode: 'cancel_oldest' as const,
      reduce_only: false,
    };
    // Omitting position_side must reproduce the historical KAT bytes exactly —
    // a one-way payload may not drift now that the field exists.
    expect(buildNativeOrderAction(base)).toBe(KAT_ACTION_JSON);
    expect(buildNativeOrderAction({ ...base, position_side: undefined })).toBe(
      KAT_ACTION_JSON,
    );
  });

  it('hedge order appends position_side last in the order body', async () => {
    const { buildNativeOrderAction } = await import('../src/native.js');
    const long = buildNativeOrderAction({
      owner: '0x000000000000000000000000000000000000beef',
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
      position_side: 'long',
    });
    expect(long).toBe(
      '{"type":"submit_order","order":{"owner":"0x000000000000000000000000000000000000beef","market":1,"side":"bid","kind":"limit","size":1000,"limit_px":5000000000000,"tif":"gtc","stp_mode":"cancel_oldest","reduce_only":false,"position_side":"long"}}',
    );
    // short differs only in the trailing token.
    const short = buildNativeOrderAction({
      owner: '0x000000000000000000000000000000000000beef',
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
      position_side: 'short',
    });
    expect(short.endsWith('"position_side":"short"}}')).toBe(true);
    expect(long).not.toBe(short);
  });

  // ---- set_position_mode ----

  it('buildNativeSetPositionModeAction emits the canonical params shape', async () => {
    const { buildNativeSetPositionModeAction } = await import(
      '../src/native.js'
    );
    expect(buildNativeSetPositionModeAction({ hedge: true })).toBe(
      '{"type":"set_position_mode","params":{"hedge":true}}',
    );
    expect(buildNativeSetPositionModeAction({ hedge: false })).toBe(
      '{"type":"set_position_mode","params":{"hedge":false}}',
    );
  });

  it('set_position_mode sign → recover round-trips + body embeds verbatim', async () => {
    const {
      buildNativeSetPositionModeAction,
      signNativeAction,
      recoverNativeSigner,
      nativeRequestBody,
    } = await import('../src/native.js');
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wasm.js');

    const privKey = new Uint8Array(32).fill(0x42);
    const probeDigest = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probeDigest);
    const probePub = await recoverPubkey(probeSig, probeDigest);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const actionJson = buildNativeSetPositionModeAction({ hedge: true });
    const signed = await signNativeAction(privKey, actionJson, 3n, KAT_CHAIN_ID);
    expect(signed.actionJson).toBe(actionJson);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
    expect(nativeRequestBody(signed).includes(`"action":${actionJson}`)).toBe(
      true,
    );
  });

  // ---- spot_order ----

  it('buildNativeSpotOrderAction emits the canonical order shape', async () => {
    const { buildNativeSpotOrderAction } = await import('../src/native.js');
    expect(
      buildNativeSpotOrderAction({
        pair: 200,
        side: 'bid',
        size: 10,
        limit_px: 200_000_000,
        tif: 'ioc',
        stp_mode: 'cancel_oldest',
      }),
    ).toBe(
      '{"type":"spot_order","order":{"pair":200,"side":"bid","size":10,"limit_px":200000000,"tif":"ioc","stp_mode":"cancel_oldest"}}',
    );
  });

  it('spot_order appends cloid when present', async () => {
    const { buildNativeSpotOrderAction } = await import('../src/native.js');
    const json = buildNativeSpotOrderAction({
      pair: 200,
      side: 'ask',
      size: 5,
      limit_px: 100_000_000,
      tif: 'ioc',
      stp_mode: 'cancel_newest',
      cloid: '0xabababababababababababababababab',
    });
    expect(json.endsWith('"cloid":"0xabababababababababababababababab"}}')).toBe(
      true,
    );
  });

  it('spot_order v0 rejects non-ioc tif and a non-positive limit_px', async () => {
    const { buildNativeSpotOrderAction } = await import('../src/native.js');
    expect(() =>
      buildNativeSpotOrderAction({
        pair: 1,
        side: 'bid',
        size: 1,
        limit_px: 1,
        tif: 'gtc',
        stp_mode: 'cancel_oldest',
      }),
    ).toThrow();
    expect(() =>
      buildNativeSpotOrderAction({
        pair: 1,
        side: 'bid',
        size: 1,
        limit_px: 0,
        tif: 'ioc',
        stp_mode: 'cancel_oldest',
      }),
    ).toThrow();
  });

  it('spot_order sign → recover round-trips to the signer', async () => {
    const { buildNativeSpotOrderAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native.js');
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wasm.js');

    const privKey = new Uint8Array(32).fill(0x55);
    const probeDigest = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probeDigest);
    const probePub = await recoverPubkey(probeSig, probeDigest);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const actionJson = buildNativeSpotOrderAction({
      pair: 200,
      side: 'bid',
      size: 10,
      limit_px: 200_000_000,
      tif: 'ioc',
      stp_mode: 'cancel_oldest',
    });
    const signed = await signNativeAction(privKey, actionJson, 7n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  // ---- spot_cancel ----

  it('buildNativeSpotCancelAction emits the canonical cancel shape', async () => {
    const { buildNativeSpotCancelAction } = await import('../src/native.js');
    expect(buildNativeSpotCancelAction({ pair: 200, oid: 7 })).toBe(
      '{"type":"spot_cancel","cancel":{"pair":200,"oid":7}}',
    );
  });

  it('spot_cancel sign → recover round-trips + body embeds verbatim', async () => {
    const {
      buildNativeSpotCancelAction,
      signNativeAction,
      recoverNativeSigner,
      nativeRequestBody,
    } = await import('../src/native.js');
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wasm.js');

    const privKey = new Uint8Array(32).fill(0x66);
    const probeDigest = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probeDigest);
    const probePub = await recoverPubkey(probeSig, probeDigest);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const actionJson = buildNativeSpotCancelAction({ pair: 200, oid: 7 });
    const signed = await signNativeAction(privKey, actionJson, 8n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
    expect(nativeRequestBody(signed).includes(`"action":${actionJson}`)).toBe(
      true,
    );
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
