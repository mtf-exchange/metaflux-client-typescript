// Real-node native write-action builders — JSON-shape pins + a sign/recover
// round-trip. Covers a representative slice of the reconciled /exchange surface
// (vaults, leverage/margin, TWAP, staking, MetaBridge, encrypted, batch). The
// 5 original builders are byte-pinned separately in `native.test.ts`.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

// MTF testnet chain id (114514) — the SDK default.
const KAT_CHAIN_ID = 114514;

const ADDR = '0x000000000000000000000000000000000000beef';

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

describe('real native write-action builders (JSON shape)', () => {
  it('create_vault: omits parent, defaults kind to "User"', async () => {
    const { buildNativeCreateVaultAction } = await import('../src/native/actions.js');
    expect(
      buildNativeCreateVaultAction({ name: 'mlp', lock_period_secs: 604800 }),
    ).toBe(
      '{"type":"create_vault","params":{"name":"mlp","lock_period_secs":604800,"kind":"User"}}',
    );
  });

  it('create_vault: emits parent + explicit kind', async () => {
    const { buildNativeCreateVaultAction } = await import('../src/native/actions.js');
    expect(
      buildNativeCreateVaultAction({
        name: 'v',
        lock_period_secs: 1,
        parent: 3,
        kind: 'Metaliquidity',
      }),
    ).toBe(
      '{"type":"create_vault","params":{"name":"v","lock_period_secs":1,"parent":3,"kind":"Metaliquidity"}}',
    );
  });

  it('vault_withdraw: shares as a decimal string', async () => {
    const { buildNativeVaultWithdrawAction } = await import('../src/native/actions.js');
    expect(buildNativeVaultWithdrawAction({ vault_id: 7, shares: '250.5' })).toBe(
      '{"type":"vault_withdraw","params":{"vault_id":7,"shares":"250.5"}}',
    );
  });

  it('update_leverage: snake_case integers + bool', async () => {
    const { buildNativeUpdateLeverageAction } = await import('../src/native/actions.js');
    expect(
      buildNativeUpdateLeverageAction({ asset: 2, leverage: 10, is_isolated: true }),
    ).toBe(
      '{"type":"update_leverage","params":{"asset":2,"leverage":10,"is_isolated":true}}',
    );
  });

  it('update_isolated_margin: signed delta as a string', async () => {
    const { buildNativeUpdateIsolatedMarginAction } = await import(
      '../src/native/actions.js'
    );
    expect(
      buildNativeUpdateIsolatedMarginAction({ asset: 1, delta: '-12.5' }),
    ).toBe(
      '{"type":"update_isolated_margin","params":{"asset":1,"delta":"-12.5"}}',
    );
  });

  it('twap_order: full slice shape', async () => {
    const { buildNativeTwapOrderAction } = await import('../src/native/actions.js');
    expect(
      buildNativeTwapOrderAction({
        market: 4,
        side: 'ask',
        total_size: 1000,
        slice_count: 10,
        delay_ms: 500,
        reduce_only: true,
      }),
    ).toBe(
      '{"type":"twap_order","params":{"market":4,"side":"ask","total_size":1000,"slice_count":10,"delay_ms":500,"reduce_only":true}}',
    );
  });

  it('token_delegate: decimal amount + bool', async () => {
    const { buildNativeTokenDelegateAction } = await import('../src/native/actions.js');
    expect(
      buildNativeTokenDelegateAction({
        validator: ADDR,
        amount: '100.5',
        is_undelegate: false,
      }),
    ).toBe(
      `{"type":"token_delegate","params":{"validator":"${ADDR}","amount":"100.5","is_undelegate":false}}`,
    );
  });

  it('mb_withdraw: PascalCase chain + 20-byte dst_addr', async () => {
    const { buildNativeMbWithdrawAction } = await import('../src/native/actions.js');
    const dst = '0xabababababababababababababababababababab';
    expect(
      buildNativeMbWithdrawAction({ chain: 'Base', asset: 0, amount: 1000000, dst_addr: dst }),
    ).toBe(
      `{"type":"mb_withdraw","params":{"chain":"Base","asset":0,"amount":1000000,"dst_addr":"${dst}"}}`,
    );
  });

  it('submit_encrypted_order: ciphertext + 32-byte commitment as byte arrays', async () => {
    const { buildNativeSubmitEncryptedOrderAction } = await import(
      '../src/native/actions.js'
    );
    const commitment = '[' + new Array(32).fill(0).join(',') + ']';
    expect(
      buildNativeSubmitEncryptedOrderAction({
        ciphertext: new Uint8Array([1, 2, 255]),
        commitment: new Uint8Array(32),
        threshold: 2,
        target_block: 100,
        reveal_deadline_ms: 5000,
      }),
    ).toBe(
      `{"type":"submit_encrypted_order","params":{"ciphertext":[1,2,255],"commitment":${commitment},"threshold":2,"target_block":100,"reveal_deadline_ms":5000}}`,
    );
  });

  it('submit_encrypted_order: rejects a non-32-byte commitment', async () => {
    const { buildNativeSubmitEncryptedOrderAction } = await import(
      '../src/native/actions.js'
    );
    expect(() =>
      buildNativeSubmitEncryptedOrderAction({
        ciphertext: new Uint8Array([1]),
        commitment: new Uint8Array(16),
        threshold: 1,
        target_block: 1,
        reveal_deadline_ms: 1,
      }),
    ).toThrow();
  });

  it('batch_order: array of order bodies + default grouping', async () => {
    const { buildNativeBatchOrderAction } = await import('../src/native/actions.js');
    expect(
      buildNativeBatchOrderAction({
        orders: [
          {
            owner: ADDR,
            market: 1,
            side: 'bid',
            kind: 'limit',
            size: 1000,
            limit_px: 5000,
            tif: 'gtc',
            stp_mode: 'cancel_oldest',
            reduce_only: false,
          },
        ],
      }),
    ).toBe(
      `{"type":"batch_order","params":{"orders":[{"owner":"${ADDR}","market":1,"side":"bid","kind":"limit","size":1000,"limit_px":5000,"tif":"gtc","stp_mode":"cancel_oldest","reduce_only":false}],"grouping":"na"}}`,
    );
  });

  it('cancel_all_orders: empty params when no asset filter', async () => {
    const { buildNativeCancelAllOrdersAction } = await import(
      '../src/native/actions.js'
    );
    expect(buildNativeCancelAllOrdersAction()).toBe(
      '{"type":"cancel_all_orders","params":{}}',
    );
  });
});

describe.skipIf(!wasmBuilt)('real native write-action sign → recover', () => {
  it('update_leverage round-trips to the signer (sender-authorized)', async () => {
    const { buildNativeUpdateLeverageAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x42);
    const expected = await signerAddress(privKey);
    const actionJson = buildNativeUpdateLeverageAction({
      asset: 1,
      leverage: 10,
      is_isolated: false,
    });
    const signed = await signNativeAction(privKey, actionJson, 1n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('create_vault round-trips to the signer (the leader)', async () => {
    const { buildNativeCreateVaultAction, signNativeAction, recoverNativeSigner } =
      await import('../src/native/index.js');
    const privKey = new Uint8Array(32).fill(0x55);
    const expected = await signerAddress(privKey);
    const actionJson = buildNativeCreateVaultAction({
      name: 'mlp',
      lock_period_secs: 604800,
    });
    const signed = await signNativeAction(privKey, actionJson, 2n, KAT_CHAIN_ID);
    const recovered = await recoverNativeSigner(signed, KAT_CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });
});
