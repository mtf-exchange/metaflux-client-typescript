// New native write-action builders — JSON-shape pins + sign/recover round-trips.
//
// Covers the vault / portfolio-margin / RFQ / FBA / cross-chain / encrypted
// actions added alongside the directory restructure. OWNER-CHECKED actions
// assert the recovered signer equals the actor field; SENDER-AUTHORIZED actions
// assert the JSON shape + a stable recovered address.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

// MTF testnet chain id (114514) — the SDK default.
const KAT_CHAIN_ID = 114514;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// Derive the signer's own 0x address from a fixed private key.
async function signerAddress(privKey: Uint8Array): Promise<string> {
  const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
    await import('../src/wallet/wasm.js');
  const probeDigest = await keccak256(new TextEncoder().encode('probe'));
  const probeSig = await signSecp256k1(privKey, probeDigest);
  const probePub = await recoverPubkey(probeSig, probeDigest);
  return `0x${toHex(await deriveAddressFromPubkey(probePub))}`;
}

describe.skipIf(!wasmBuilt)('new native write-action builders', () => {
  // ---- vault_create (OWNER-CHECKED) ----

  it('buildNativeVaultCreateAction emits the canonical vault shape', async () => {
    const { buildNativeVaultCreateAction } = await import(
      '../src/native/index.js'
    );
    expect(
      buildNativeVaultCreateAction({
        leader: '0x000000000000000000000000000000000000beef',
        seed_cents: 100_000,
        management_fee_bps: 200,
      }),
    ).toBe(
      '{"type":"vault_create","vault":{"leader":"0x000000000000000000000000000000000000beef","seed_cents":100000,"management_fee_bps":200}}',
    );
  });

  it('vault_create sign → recover round-trips to the leader', async () => {
    const { buildNativeVaultCreateAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x42);
    const leader = await signerAddress(privKey);
    const actionJson = buildNativeVaultCreateAction({
      leader,
      seed_cents: 100_000,
      management_fee_bps: 200,
    });
    const signed = await signNativeAction(privKey, actionJson, 1n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(leader.toLowerCase());
  });

  // ---- vault_withdraw (SENDER-AUTHORIZED, u128 shares) ----

  it('buildNativeVaultWithdrawAction emits shares as a bare u128 integer', async () => {
    const { buildNativeVaultWithdrawAction } = await import(
      '../src/native/index.js'
    );
    expect(
      buildNativeVaultWithdrawAction({
        vault_id: 7,
        shares: 340282366920938463463374607431768211455n, // 2^128 - 1
      }),
    ).toBe(
      '{"type":"vault_withdraw","params":{"vault_id":7,"shares":340282366920938463463374607431768211455}}',
    );
  });

  it('vault_withdraw rejects a u128 overflow', async () => {
    const { buildNativeVaultWithdrawAction } = await import(
      '../src/native/index.js'
    );
    expect(() =>
      buildNativeVaultWithdrawAction({ vault_id: 1, shares: 1n << 128n }),
    ).toThrow();
  });

  it('vault_withdraw sign → recover yields a stable address', async () => {
    const { buildNativeVaultWithdrawAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x55);
    const expected = await signerAddress(privKey);
    const actionJson = buildNativeVaultWithdrawAction({
      vault_id: 7,
      shares: 1000n,
    });
    const signed = await signNativeAction(privKey, actionJson, 2n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });

  // ---- pm_enroll (OWNER-CHECKED) ----

  it('buildNativePmEnrollAction emits the canonical params shape', async () => {
    const { buildNativePmEnrollAction } = await import('../src/native/index.js');
    expect(
      buildNativePmEnrollAction({
        user: '0x000000000000000000000000000000000000beef',
      }),
    ).toBe(
      '{"type":"pm_enroll","params":{"user":"0x000000000000000000000000000000000000beef"}}',
    );
  });

  it('pm_enroll sign → recover round-trips to the user', async () => {
    const { buildNativePmEnrollAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x66);
    const user = await signerAddress(privKey);
    const actionJson = buildNativePmEnrollAction({ user });
    const signed = await signNativeAction(privKey, actionJson, 3n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(user.toLowerCase());
  });

  // ---- cross_chain_send (OWNER-CHECKED, u128 amount) ----

  it('buildNativeCrossChainSendAction emits the canonical msg shape', async () => {
    const { buildNativeCrossChainSendAction } = await import(
      '../src/native/index.js'
    );
    expect(
      buildNativeCrossChainSendAction({
        sender: '0x000000000000000000000000000000000000beef',
        dst_chain: 8964,
        dst_address: '0x000000000000000000000000000000000000cafe',
        asset: 'USDC',
        amount: 1000000n,
        nonce: 5,
      }),
    ).toBe(
      '{"type":"cross_chain_send","msg":{"sender":"0x000000000000000000000000000000000000beef","dst_chain":8964,"dst_address":"0x000000000000000000000000000000000000cafe","asset":"USDC","amount":1000000,"nonce":5}}',
    );
  });

  it('cross_chain_send sign → recover round-trips to the sender', async () => {
    const {
      buildNativeCrossChainSendAction,
      signNativeAction,
      recoverNativeSigner,
    } = await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x77);
    const sender = await signerAddress(privKey);
    const actionJson = buildNativeCrossChainSendAction({
      sender,
      dst_chain: 8964,
      dst_address: '0x000000000000000000000000000000000000cafe',
      asset: 'USDC',
      amount: 1000000n,
      nonce: 5,
    });
    const signed = await signNativeAction(privKey, actionJson, 4n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(sender.toLowerCase());
  });

  // ---- encrypted_order_submit (OWNER-CHECKED, Vec<u8> ciphertext) ----

  it('buildNativeEncryptedOrderSubmitAction emits ciphertext as a byte array', async () => {
    const { buildNativeEncryptedOrderSubmitAction } = await import(
      '../src/native/index.js'
    );
    expect(
      buildNativeEncryptedOrderSubmitAction({
        submitter: '0x000000000000000000000000000000000000beef',
        ciphertext: new Uint8Array([1, 2, 255]),
        threshold: 3,
        target_block: 1000,
      }),
    ).toBe(
      '{"type":"encrypted_order_submit","encrypted":{"submitter":"0x000000000000000000000000000000000000beef","ciphertext":[1,2,255],"threshold":3,"target_block":1000}}',
    );
  });
});
