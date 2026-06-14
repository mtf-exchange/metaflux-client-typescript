// EIP-712 typed-action signing — cross-impl known-answer vectors + round-trips.
//
// Pins the TS typed-action digest to the SAME value the server commits to for
// the 18 reachable actions (chain id 114514 / "Testnet"). If a digest drifts,
// the TS SDK is signing something the server will not verify. Vectors mirror the
// server's `all_actions()` fixtures; the digest pins are the frozen contract.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

if (!wasmBuilt) {

  console.warn(
    '[typed.test.ts] pkg/ not found — skipping WASM tests. ' +
      'Run `npm run build:wasm` to enable.',
  );
}

const CHAIN_ID = 114514;

/// Expand a single byte into a `0x` + 40-hex address (`addr(byte)` in the server
/// fixtures = that byte repeated 20 times).
function addr(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
}
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// Every reachable typed action with its server-fixture inputs (snake_case
/// payload) + nonce + the contract's frozen digest pin (chain 114514).
interface Vector {
  actionType: string;
  payload: Record<string, unknown>;
  nonce: bigint;
  digest: string;
}

const VECTORS: Vector[] = [
  {
    actionType: 'approve_agent',
    payload: { agent: addr(0xa1), name: 'trading-bot', expires_at_ms: 1_700_000_000_000 },
    nonce: 1n,
    digest: '569bb62f0cd468264550e8bdc4c37abcf273bdd48569bed37b985c5d6e94693e',
  },
  {
    actionType: 'set_referrer',
    payload: { referrer: addr(0xb2) },
    nonce: 2n,
    digest: '7b7cf887e46300ec4728f84383f11957c3ec61d899604a120b8cb6aba923110f',
  },
  {
    actionType: 'approve_builder_fee',
    payload: { builder: addr(0xc3), max_bps: 25 },
    nonce: 3n,
    digest: 'ca2b79bb54279dcb4b213e3a46e900fff14178a6d3708623ea04a6797e19ef72',
  },
  {
    actionType: 'set_display_name',
    payload: { display_name: 'alice' },
    nonce: 4n,
    digest: 'cc6752669ed0658d0d26490b25b3654ae6d62607842b844a92a286ec89fe58a2',
  },
  {
    actionType: 'set_position_mode',
    payload: { hedge: true },
    nonce: 5n,
    digest: '4d3e4b648fa986b5428c866d29300c0d0e60d2a7e65e426f387725433ba7c60b',
  },
  {
    actionType: 'user_portfolio_margin',
    payload: { enroll: true },
    nonce: 6n,
    digest: 'dae23a05e78df7b205a2ff5165926bd9ee26a164bb8e06fc1bc95f077cf0f11c',
  },
  {
    actionType: 'convert_to_multi_sig_user',
    payload: { signers: [addr(0x11), addr(0x22), addr(0x33)], threshold: 2 },
    nonce: 7n,
    digest: '981a2b3adb1d0c03a7af30076f3c6497ffeabe79e380b01be4f1f14eb1252e84',
  },
  {
    actionType: 'update_leverage',
    payload: { asset: 1, leverage: 10, is_isolated: false },
    nonce: 8n,
    digest: '71acc19d6d20f4b2a24643c530c3ec2f6232dea52470e581f74fb41a6bad2654',
  },
  {
    actionType: 'claim_rewards',
    payload: { validator: ZERO_ADDR },
    nonce: 12n,
    digest: '434e12e0438e2960d3a8692de6619daaee358c41613ea01ce299aee549fd6495',
  },
  {
    actionType: 'link_staking_user',
    payload: { target: addr(0xe5) },
    nonce: 13n,
    digest: 'b23d7cfa00b94e8f8b9b04cb8a54ce3e2c597975ac8ee4e43b4c2ecdc91305ce',
  },
  {
    actionType: 'create_vault',
    payload: { name: 'my-vault', lock_period_secs: 86_400, kind: 1 },
    nonce: 15n,
    digest: 'a43bee9c8500dd4f6a1109567daa8edbba06e09b91e50b78a4b78fd64ccbcc0f',
  },
  {
    actionType: 'vault_modify',
    payload: { vault_id: 42, new_name: 'renamed-vault' },
    nonce: 17n,
    digest: '28eea2c131a8e72a1948b49cf42072aadffea8301c78b86272dc00cca9f3786f',
  },
  {
    actionType: 'spot_margin_close',
    payload: { pair: 5, limit_px: 5_000_000_000 },
    nonce: 23n,
    digest: '192066d65101d8a19e4632231cc1a426740b3df1ceb9c38955ac600ebd8cde7e',
  },
  {
    actionType: 'send_asset',
    payload: {
      source_dex: 0,
      destination_dex: 1,
      asset: 2,
      destination: addr(0x3c),
      amount: '750.25',
      to_perp: true,
    },
    nonce: 28n,
    digest: '88aa17af1dc0d6d35934ada321549a4b8b6a4d964f9c5263e1200b4f696cac4d',
  },
  {
    actionType: 'usd_class_transfer',
    payload: { ntl: '1000', to_perp: false },
    nonce: 29n,
    digest: 'e8c4a52934cadc57024f44fb08c3e1334d13e64e5e99db2ec812f3a357be4330',
  },
  {
    actionType: 'withdraw',
    payload: { asset: 0, amount: '100', destination_chain_id: 8453, use_cctp: true },
    nonce: 30n,
    digest: '9b047067f8fd3f6ad9b10da914450e2e3f03c5057bdb10a8e90126d26b94b742',
  },
  {
    actionType: 'set_metaliquidity_set',
    payload: { account: addr(0x6f), allowed: true },
    nonce: 33n,
    digest: 'cfd79d25d8a119f2832fde37f710456f3946c16dadda4af653b2710999f8e441',
  },
  {
    actionType: 'register_metaliquidity_operator',
    payload: {
      vault_id: 42,
      operator: addr(0x70),
      allowed: true,
      expires_at_ms: 1_700_000_000_000,
    },
    nonce: 34n,
    digest: '4de965c3bc25f15ddafa0b778179909f50cd0930bf4f58a652dde93bce524c80',
  },
  // ---- the 12 formerly-deferred actions (now typed) ----
  {
    actionType: 'update_isolated_margin',
    payload: { asset: 1, delta: '-100.5' },
    nonce: 9n,
    digest: 'f3ca20d10ce710d31de3d321d61d60b53550adbb4dfd09fca9b7a8c8dbc08162',
  },
  {
    actionType: 'top_up_isolated_only_margin',
    payload: { asset: 1, amount: '50' },
    nonce: 10n,
    digest: '47647d208358a681eb657867da2ce00dfeb010a7f2023ecb69e195642da24c8a',
  },
  {
    actionType: 'token_delegate',
    payload: { validator: addr(0xd4), amount: '1000', is_undelegate: false },
    nonce: 11n,
    digest: '5327737fefc7ee3b38b59743fb4ba311d9142a7c672ec59ca92c5a871173008b',
  },
  {
    actionType: 'agent_set_abstraction',
    payload: { user: addr(0xf6), kind: 3, value: 'abstraction-value' },
    nonce: 14n,
    digest: '0dd8a92857e2f4aafd97dd0131704bab22969345844389d2b214d55f2a7de71e',
  },
  {
    actionType: 'vault_transfer',
    payload: { vault_id: 42, deposit: true, amount: '250.75' },
    nonce: 16n,
    digest: 'd5da325a4e1331ebd6a158d7192795a3eeaf2a39c86b90d44cd5506c98ececc9',
  },
  {
    actionType: 'vault_withdraw',
    payload: { vault_id: 42, shares: '10.5' },
    nonce: 18n,
    digest: 'ca6c76e49c7cedd99df8d27ee85d14175b954d25bdac53f9525e6b8c71f6b5a7',
  },
  {
    // chain "Arbitrum" => signed uint8 code 2; amount is a uint64 integer.
    actionType: 'mb_withdraw',
    payload: { chain: 'Arbitrum', asset: 1, amount: 1_000_000, dst_addr: '0xdeadbeef' },
    nonce: 19n,
    digest: '423f327abdec7b3469b6dc5d4993ac4a11f0a09487cec564b85d8162abdee2e8',
  },
  {
    actionType: 'spot_margin_deposit',
    payload: { pair: 5, amount: '100' },
    nonce: 20n,
    digest: '3d2f440131e3059d8ac4329864f258ae8c799f82323785a36420182ed3e304fd',
  },
  {
    actionType: 'spot_margin_withdraw',
    payload: { pair: 5, amount: '50' },
    nonce: 21n,
    digest: '44540925574b90c68c0cb4c5773d2d51e14d3c3ddd6c9fe5b97e81aba67e768c',
  },
  {
    actionType: 'spot_margin_open',
    payload: { pair: 5, size: 1_000, limit_px: 5_000_000_000, borrow: '200' },
    nonce: 22n,
    digest: 'd56110f1e4adb4fbd07a72b870678425bd5440d2119e3d9d9f205469c6dbd4c1',
  },
  {
    actionType: 'earn_deposit',
    payload: { asset: 0, amount: '500' },
    nonce: 24n,
    digest: '947530d85221850f892412799ef45baef7f5a75663272bc565e81c519879664e',
  },
  {
    actionType: 'earn_withdraw',
    payload: { asset: 0, shares: '25.5' },
    nonce: 25n,
    digest: '5244365c226ab1b7ec786129f134d104a2923a57b9cc2588d6b215aef5b55018',
  },
];

describe.skipIf(!wasmBuilt)('EIP-712 typed-action signing', () => {
  it('reproduces all 30 contract KAT digests byte-for-byte (chain 114514)', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    expect(VECTORS.length).toBe(30);
    for (const v of VECTORS) {
      const built = buildTyped(v.actionType, v.payload, v.nonce, CHAIN_ID);
      const digest = await typedActionDigest(built);
      expect(toHex(digest), `digest mismatch for ${v.actionType}`).toBe(v.digest);
    }
  });

  // The three fully-specified vectors called out in the contract, asserted
  // individually so a failure names the offending action.
  it('ApproveAgent matches the contract pin', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const built = buildTyped(
      'approve_agent',
      { agent: addr(0xa1), name: 'trading-bot', expires_at_ms: 1_700_000_000_000 },
      1n,
      CHAIN_ID,
    );
    expect(toHex(await typedActionDigest(built))).toBe(
      '569bb62f0cd468264550e8bdc4c37abcf273bdd48569bed37b985c5d6e94693e',
    );
  });

  it('SendAsset matches the contract pin', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const built = buildTyped(
      'send_asset',
      {
        source_dex: 0,
        destination_dex: 1,
        asset: 2,
        destination: addr(0x3c),
        amount: '750.25',
        to_perp: true,
      },
      28n,
      CHAIN_ID,
    );
    expect(toHex(await typedActionDigest(built))).toBe(
      '88aa17af1dc0d6d35934ada321549a4b8b6a4d964f9c5263e1200b4f696cac4d',
    );
  });

  it('ConvertToMultiSigUser (address[] rule) matches the contract pin', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const built = buildTyped(
      'convert_to_multi_sig_user',
      { signers: [addr(0x11), addr(0x22), addr(0x33)], threshold: 2 },
      7n,
      CHAIN_ID,
    );
    expect(toHex(await typedActionDigest(built))).toBe(
      '981a2b3adb1d0c03a7af30076f3c6497ffeabe79e380b01be4f1f14eb1252e84',
    );
  });

  it('encodeType strings match the frozen contract (field order)', async () => {
    const { encodeType } = await import('../src/native/typed.js');
    expect(encodeType('approve_agent')).toBe(
      'MetaFluxTransaction:ApproveAgent(string metafluxChain,address agentAddress,string agentName,uint64 expiresAtMs,uint64 nonce)',
    );
    expect(encodeType('send_asset')).toBe(
      'MetaFluxTransaction:SendAsset(string metafluxChain,uint32 sourceDex,uint32 destinationDex,uint32 asset,address destination,string amount,bool toPerp,uint64 nonce)',
    );
    expect(encodeType('convert_to_multi_sig_user')).toBe(
      'MetaFluxTransaction:ConvertToMultiSigUser(string metafluxChain,address[] signers,uint32 threshold,uint64 nonce)',
    );
    expect(encodeType('register_metaliquidity_operator')).toBe(
      'MetaFluxTransaction:RegisterMetaliquidityOperator(string metafluxChain,uint64 vaultId,address operator,bool allowed,uint64 expiresAtMs,uint64 nonce)',
    );
  });

  it('typedDataV4 payload: 4-field domain, primaryType, types order = encodeType', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'approve_agent',
      { agent: addr(0xa1), name: 'trading-bot', expires_at_ms: 1_700_000_000_000 },
      1n,
      CHAIN_ID,
    );
    const data = typedDataV4(built);

    // Domain: exactly the 4 fields, no salt.
    expect(data.domain).toEqual({
      name: 'MetaFlux',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    });
    expect(data.primaryType).toBe('MetaFluxTransaction:ApproveAgent');

    // types field order matches the encodeType string (chain, fields..., nonce).
    const fields = data.types[data.primaryType].map((t) => `${t.type} ${t.name}`);
    expect(fields).toEqual([
      'string metafluxChain',
      'address agentAddress',
      'string agentName',
      'uint64 expiresAtMs',
      'uint64 nonce',
    ]);

    // message values + chain tag.
    expect(data.message.metafluxChain).toBe('Testnet');
    expect(data.message.agentAddress).toBe(addr(0xa1));
    expect(data.message.agentName).toBe('trading-bot');
    expect(data.message.expiresAtMs).toBe(1_700_000_000_000);
    expect(data.message.nonce).toBe('1');
  });

  it('decimal string in the signed message == the POSTed action (verbatim)', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'send_asset',
      {
        source_dex: 0,
        destination_dex: 1,
        asset: 2,
        destination: addr(0x3c),
        amount: '750.25',
        to_perp: true,
      },
      28n,
      CHAIN_ID,
    );
    const data = typedDataV4(built);
    expect(data.message.amount).toBe('750.25');
    // The same canonical string must appear in the POST action JSON.
    expect(built.actionJson.includes('"amount":"750.25"')).toBe(true);
    // And the action JSON is the canonical snake_case shape.
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'send_asset',
      params: {
        source_dex: 0,
        destination_dex: 1,
        asset: 2,
        destination: addr(0x3c),
        amount: '750.25',
        to_perp: true,
      },
    });
  });

  it('sign → recover round-trips to the signing address', async () => {
    const { signTypedAction, recoverTypedSigner } = await import(
      '../src/native/typed.js'
    );
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wallet/wasm.js');

    const privKey = new Uint8Array(32).fill(0x37);
    const probe = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probe);
    const probePub = await recoverPubkey(probeSig, probe);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const payload = { agent: addr(0xa1), name: 'trading-bot', expires_at_ms: 1_700_000_000_000 };
    const signed = await signTypedAction(privKey, 'approve_agent', payload, 1n, CHAIN_ID);
    expect(signed.signature.startsWith('0x')).toBe(true);
    expect(signed.signature.length).toBe(2 + 130); // 0x + 65 bytes
    const recovered = await recoverTypedSigner(signed, 'approve_agent', payload, CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('typedRequestBody carries sig_scheme:"typed" + the verbatim action', async () => {
    const { signTypedAction, typedRequestBody } = await import('../src/native/typed.js');
    const privKey = new Uint8Array(32).fill(0x42);
    const payload = { ntl: '1000', to_perp: false };
    const signed = await signTypedAction(
      privKey,
      'usd_class_transfer',
      payload,
      29n,
      CHAIN_ID,
    );
    const body = typedRequestBody(signed);
    expect(body.includes(`"action":${signed.actionJson}`)).toBe(true);
    expect(body.includes('"sig_scheme":"typed"')).toBe(true);
    expect(body.includes('"nonce":29')).toBe(true);
    const parsed = JSON.parse(body) as {
      action: unknown;
      nonce: number;
      signature: string;
      sig_scheme: string;
    };
    expect(parsed.sig_scheme).toBe('typed');
    expect(parsed.nonce).toBe(29);
    expect(JSON.parse(signed.actionJson)).toEqual(parsed.action);
  });

  it('digest is sensitive to nonce and chainId', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const base = await typedActionDigest(
      buildTyped('set_position_mode', { hedge: true }, 5n, CHAIN_ID),
    );
    const otherNonce = await typedActionDigest(
      buildTyped('set_position_mode', { hedge: true }, 6n, CHAIN_ID),
    );
    const otherChain = await typedActionDigest(
      buildTyped('set_position_mode', { hedge: true }, 5n, 31337),
    );
    expect(toHex(base)).not.toBe(toHex(otherNonce));
    expect(toHex(base)).not.toBe(toHex(otherChain));
  });

  it('isTypedAction / TYPED_ACTION_TYPES cover exactly the 30 reachable actions', async () => {
    const { isTypedAction, TYPED_ACTION_TYPES } = await import('../src/native/typed.js');
    expect(TYPED_ACTION_TYPES.length).toBe(30);
    expect(isTypedAction('approve_agent')).toBe(true);
    expect(isTypedAction('submit_order')).toBe(false);
    // The 12 formerly-deferred actions are now typed too.
    expect(isTypedAction('token_delegate')).toBe(true);
    expect(isTypedAction('mb_withdraw')).toBe(true);
    expect(isTypedAction('agent_set_abstraction')).toBe(true);
    expect(isTypedAction('spot_margin_open')).toBe(true);
    expect(isTypedAction('earn_withdraw')).toBe(true);
  });

  it('encodeType strings for the 12 formerly-deferred actions match the contract', async () => {
    const { encodeType } = await import('../src/native/typed.js');
    expect(encodeType('update_isolated_margin')).toBe(
      'MetaFluxTransaction:UpdateIsolatedMargin(string metafluxChain,uint32 asset,string delta,uint64 nonce)',
    );
    expect(encodeType('top_up_isolated_only_margin')).toBe(
      'MetaFluxTransaction:TopUpIsolatedOnlyMargin(string metafluxChain,uint32 asset,string amount,uint64 nonce)',
    );
    expect(encodeType('token_delegate')).toBe(
      'MetaFluxTransaction:TokenDelegate(string metafluxChain,address validator,string amount,bool isUndelegate,uint64 nonce)',
    );
    expect(encodeType('agent_set_abstraction')).toBe(
      'MetaFluxTransaction:AgentSetAbstraction(string metafluxChain,address user,uint8 kind,string value,uint64 nonce)',
    );
    expect(encodeType('vault_transfer')).toBe(
      'MetaFluxTransaction:VaultTransfer(string metafluxChain,uint64 vaultId,bool deposit,string amount,uint64 nonce)',
    );
    expect(encodeType('vault_withdraw')).toBe(
      'MetaFluxTransaction:VaultWithdraw(string metafluxChain,uint64 vaultId,string shares,uint64 nonce)',
    );
    expect(encodeType('mb_withdraw')).toBe(
      'MetaFluxTransaction:MbWithdraw(string metafluxChain,uint8 chain,uint32 asset,uint64 amount,string dstAddr,uint64 nonce)',
    );
    expect(encodeType('spot_margin_deposit')).toBe(
      'MetaFluxTransaction:SpotMarginDeposit(string metafluxChain,uint32 pair,string amount,uint64 nonce)',
    );
    expect(encodeType('spot_margin_withdraw')).toBe(
      'MetaFluxTransaction:SpotMarginWithdraw(string metafluxChain,uint32 pair,string amount,uint64 nonce)',
    );
    expect(encodeType('spot_margin_open')).toBe(
      'MetaFluxTransaction:SpotMarginOpen(string metafluxChain,uint32 pair,uint64 size,uint64 limitPx,string borrow,uint64 nonce)',
    );
    expect(encodeType('earn_deposit')).toBe(
      'MetaFluxTransaction:EarnDeposit(string metafluxChain,uint32 asset,string amount,uint64 nonce)',
    );
    expect(encodeType('earn_withdraw')).toBe(
      'MetaFluxTransaction:EarnWithdraw(string metafluxChain,uint32 asset,string shares,uint64 nonce)',
    );
  });

  it('mb_withdraw: POST params.chain is the NAME, the v4 message field is the uint8 code', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'mb_withdraw',
      { chain: 'Arbitrum', asset: 1, amount: 1_000_000, dst_addr: '0xdeadbeef' },
      19n,
      CHAIN_ID,
    );
    // The POST action JSON carries the string chain name verbatim.
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'mb_withdraw',
      params: { chain: 'Arbitrum', asset: 1, amount: 1_000_000, dst_addr: '0xdeadbeef' },
    });
    // The signed v4 message renders `chain` as the uint8 code (Arbitrum=2).
    const data = typedDataV4(built);
    expect(data.message.chain).toBe(2);
    expect(
      data.types[data.primaryType].find((t) => t.name === 'chain')?.type,
    ).toBe('uint8');
  });

  it('agent_set_abstraction: value is an EIP-712 string, kind is uint8', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    const built = buildTyped(
      'agent_set_abstraction',
      { user: addr(0xf6), kind: 3, value: 'abstraction-value' },
      14n,
      CHAIN_ID,
    );
    const data = typedDataV4(built);
    expect(data.message.kind).toBe(3);
    expect(data.message.value).toBe('abstraction-value');
    const fields = data.types[data.primaryType];
    expect(fields.find((t) => t.name === 'kind')?.type).toBe('uint8');
    expect(fields.find((t) => t.name === 'value')?.type).toBe('string');
    // The same value string appears verbatim in the POST action JSON.
    expect(built.actionJson.includes('"value":"abstraction-value"')).toBe(true);
  });

  it('decimal delta/shares/borrow ride verbatim into the POST action', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const im = buildTyped('update_isolated_margin', { asset: 1, delta: '-100.5' }, 9n, CHAIN_ID);
    expect(im.actionJson.includes('"delta":"-100.5"')).toBe(true);
    const vw = buildTyped('vault_withdraw', { vault_id: 42, shares: '10.5' }, 18n, CHAIN_ID);
    expect(vw.actionJson.includes('"shares":"10.5"')).toBe(true);
    const so = buildTyped(
      'spot_margin_open',
      { pair: 5, size: 1_000, limit_px: 5_000_000_000, borrow: '200' },
      22n,
      CHAIN_ID,
    );
    expect(so.actionJson.includes('"borrow":"200"')).toBe(true);
  });
});
