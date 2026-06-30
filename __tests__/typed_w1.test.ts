// W1 typed-action KAT — RFQ / FBA microstructure + the two digest aliases.
//
// Pins the TS typed-action digest for the five W1 additions so a drift in field
// order / type / flattening is caught before it reaches the wire:
//   - rfq_request / rfq_accept / fba_submit  (NEW sender-authorized typed actions)
//   - encrypted_order_submit  (NEW tag, ALIAS of the SubmitEncryptedOrder digest)
//   - pm_unenroll             (NEW paramless tag, ALIAS of UserPortfolioMargin{false})
//
// There is no pinned cross-impl server fixture for these yet, so the contract is
// asserted three ways: (1) the encodeType strings match the node's frozen type
// strings byte-for-byte; (2) the two aliases reproduce the EXACT digest of the
// action they alias (the node reuses the same TypedAction); (3) a regression pin
// on the computed digest for the three new shapes. All over the same 0x1901
// machinery the 41 contract KATs already validate.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..', 'pkg');
const wasmBuilt = existsSync(resolve(pkgDir, 'metaflux_client_wasm.js'));

const CHAIN_ID = 114514;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// A deterministic 32-byte commitment + a short ciphertext for the encrypted KATs.
const COMMITMENT = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff),
);
const CIPHERTEXT = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);

// The frozen node EIP-712 type strings these actions must reproduce (verbatim
// from the W1 node `signing_typed_*` encoders).
const ENCODE_TYPES = {
  rfq_request:
    'MetaFluxTransaction:RfqRequest(string metafluxChain,uint32 market,uint8 side,uint64 size,bool hasLimitPx,uint64 limitPx,uint64 expiryMs,bool hasStpGroup,uint64 stpGroup,uint64 nonce)',
  rfq_accept:
    'MetaFluxTransaction:RfqAccept(string metafluxChain,uint64 rfqId,uint32 quoteIdx,uint64 size,uint64 nonce)',
  fba_submit:
    'MetaFluxTransaction:FbaSubmit(string metafluxChain,uint32 market,uint8 side,uint64 size,uint64 price,bool hasStpGroup,uint64 stpGroup,uint64 nonce)',
  encrypted_order_submit:
    'MetaFluxTransaction:SubmitEncryptedOrder(string metafluxChain,bytes ciphertext,bytes32 commitment,uint8 threshold,uint64 targetBlock,uint64 revealDeadlineMs,uint64 nonce)',
  pm_unenroll:
    'MetaFluxTransaction:UserPortfolioMargin(string metafluxChain,bool enroll,uint64 nonce)',
} as const;

// Regression digest pins for the three new shapes (chain 114514). Computed by
// the same machinery as the 41 contract KATs; pinned so a field-order / type /
// flattening drift fails loudly.
const DIGEST_PINS = {
  rfq_request: 'db5a2fe0507c166abdc89f952b94270af4d766256b7bd74ceb3eee6328b3cf13',
  rfq_accept: '85d103b3442922dbf349b651cc6517fcd2c888e10e670e3209f9151d8e43f598',
  fba_submit: '7e8ad865c2e04cf58db4a2a4e069cd331b9426343c7b55fb62ba0ed493d023de',
} as const;

describe('W1 typed-action encodeType strings (frozen contract)', () => {
  it('match the node type strings byte-for-byte', async () => {
    const { encodeType, primaryType } = await import('../src/native/typed.js');
    expect(encodeType('rfq_request')).toBe(ENCODE_TYPES.rfq_request);
    expect(encodeType('rfq_accept')).toBe(ENCODE_TYPES.rfq_accept);
    expect(encodeType('fba_submit')).toBe(ENCODE_TYPES.fba_submit);
    // The two aliases reuse the existing primary type (NOT a new struct).
    expect(encodeType('encrypted_order_submit')).toBe(
      ENCODE_TYPES.encrypted_order_submit,
    );
    expect(encodeType('pm_unenroll')).toBe(ENCODE_TYPES.pm_unenroll);
    expect(primaryType('encrypted_order_submit')).toBe(
      'MetaFluxTransaction:SubmitEncryptedOrder',
    );
    expect(primaryType('pm_unenroll')).toBe(
      'MetaFluxTransaction:UserPortfolioMargin',
    );
  });
});

describe('W1 typed-action wire shapes', () => {
  it('rfq_request flattens Option<u64> + signs side as a uint8 name', async () => {
    const { buildTyped, typedDataV4 } = await import('../src/native/typed.js');
    // Both optionals present.
    const full = buildTyped(
      'rfq_request',
      {
        market: 7,
        side: 'Bid',
        size: 1000n,
        limit_px: 42_000n,
        expiry_ms: 1_700_000_000_000,
        stp_group: 3,
      },
      11n,
      CHAIN_ID,
    );
    expect(JSON.parse(full.actionJson)).toEqual({
      type: 'rfq_request',
      params: {
        market: 7,
        side: 'Bid',
        size: 1000,
        limit_px: 42000,
        expiry_ms: 1_700_000_000_000,
        stp_group: 3,
      },
    });
    const data = typedDataV4(full);
    expect(data.types[data.primaryType].map((f) => f.name)).toEqual([
      'metafluxChain',
      'market',
      'side',
      'size',
      'hasLimitPx',
      'limitPx',
      'expiryMs',
      'hasStpGroup',
      'stpGroup',
      'nonce',
    ]);
    // side rides the v4 message + signed word as the uint8 code (Bid=0).
    expect(data.message.side).toBe(0);
    expect(data.message.hasLimitPx).toBe(true);
    expect(data.message.limitPx).toBe(42000);
    expect(data.message.hasStpGroup).toBe(true);
    expect(data.message.stpGroup).toBe(3);

    // Both optionals absent: keys omitted on the wire; presence halves false.
    const bare = buildTyped(
      'rfq_request',
      { market: 7, side: 'Ask', size: 1000, expiry_ms: 0 },
      11n,
      CHAIN_ID,
    );
    expect(JSON.parse(bare.actionJson)).toEqual({
      type: 'rfq_request',
      params: { market: 7, side: 'Ask', size: 1000, expiry_ms: 0 },
    });
    const bareData = typedDataV4(bare);
    expect(bareData.message.side).toBe(1); // Ask=1
    expect(bareData.message.hasLimitPx).toBe(false);
    expect(bareData.message.limitPx).toBe(0);
    expect(bareData.message.hasStpGroup).toBe(false);
    expect(bareData.message.stpGroup).toBe(0);
  });

  it('fba_submit names the price field + flattens stp_group', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const built = buildTyped(
      'fba_submit',
      { market: 5, side: 'Ask', size: 250n, price: 30_000n, stp_group: null },
      13n,
      CHAIN_ID,
    );
    // stp_group null => absent (omitted), NOT serialized as null.
    expect(JSON.parse(built.actionJson)).toEqual({
      type: 'fba_submit',
      params: { market: 5, side: 'Ask', size: 250, price: 30000 },
    });
  });

  it('pm_unenroll emits the bare paramless envelope', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const built = buildTyped('pm_unenroll', {}, 4n, CHAIN_ID);
    expect(built.actionJson).toBe('{"type":"pm_unenroll"}');
  });

  it('encrypted_order_submit carries the 5-field params object', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    const built = buildTyped(
      'encrypted_order_submit',
      {
        ciphertext: CIPHERTEXT,
        commitment: COMMITMENT,
        threshold: 2,
        target_block: 1000,
        reveal_deadline_ms: 1_700_000_000_000,
      },
      5n,
      CHAIN_ID,
    );
    const parsed = JSON.parse(built.actionJson) as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(parsed.type).toBe('encrypted_order_submit');
    expect(Object.keys(parsed.params)).toEqual([
      'ciphertext',
      'commitment',
      'threshold',
      'target_block',
      'reveal_deadline_ms',
    ]);
  });
});

describe.skipIf(!wasmBuilt)('W1 typed-action digests', () => {
  it('encrypted_order_submit reproduces the SubmitEncryptedOrder digest exactly', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const payload = {
      ciphertext: CIPHERTEXT,
      commitment: COMMITMENT,
      threshold: 2,
      target_block: 1000,
      reveal_deadline_ms: 1_700_000_000_000,
    };
    const aliasDigest = await typedActionDigest(
      buildTyped('encrypted_order_submit', payload, 5n, CHAIN_ID),
    );
    const baseDigest = await typedActionDigest(
      buildTyped('submit_encrypted_order', payload, 5n, CHAIN_ID),
    );
    expect(toHex(aliasDigest)).toBe(toHex(baseDigest));
  });

  it('pm_unenroll reproduces the UserPortfolioMargin{enroll:false} digest exactly', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const aliasDigest = await typedActionDigest(
      buildTyped('pm_unenroll', {}, 4n, CHAIN_ID),
    );
    const baseDigest = await typedActionDigest(
      buildTyped('user_portfolio_margin', { enroll: false }, 4n, CHAIN_ID),
    );
    expect(toHex(aliasDigest)).toBe(toHex(baseDigest));
    // And it must NOT collide with the enroll:true digest.
    const enrollDigest = await typedActionDigest(
      buildTyped('user_portfolio_margin', { enroll: true }, 4n, CHAIN_ID),
    );
    expect(toHex(aliasDigest)).not.toBe(toHex(enrollDigest));
  });

  it('reproduces the rfq_request / rfq_accept / fba_submit digest pins', async () => {
    const { buildTyped, typedActionDigest } = await import('../src/native/typed.js');
    const rfqRequest = await typedActionDigest(
      buildTyped(
        'rfq_request',
        {
          market: 7,
          side: 'Bid',
          size: 1000n,
          limit_px: 42_000n,
          expiry_ms: 1_700_000_000_000,
          stp_group: 3,
        },
        11n,
        CHAIN_ID,
      ),
    );
    expect(toHex(rfqRequest)).toBe(DIGEST_PINS.rfq_request);

    const rfqAccept = await typedActionDigest(
      buildTyped('rfq_accept', { rfq_id: 99, quote_idx: 1, size: 500n }, 12n, CHAIN_ID),
    );
    expect(toHex(rfqAccept)).toBe(DIGEST_PINS.rfq_accept);

    const fbaSubmit = await typedActionDigest(
      buildTyped(
        'fba_submit',
        { market: 5, side: 'Ask', size: 250n, price: 30_000n, stp_group: 9 },
        13n,
        CHAIN_ID,
      ),
    );
    expect(toHex(fbaSubmit)).toBe(DIGEST_PINS.fba_submit);
  });

  it('rfq_request sign → recover round-trips to the signing address', async () => {
    const { signTypedAction, recoverTypedSigner } = await import(
      '../src/native/typed.js'
    );
    const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
      await import('../src/wallet/wasm.js');

    const privKey = new Uint8Array(32).fill(0x5b);
    const probe = await keccak256(new TextEncoder().encode('probe'));
    const probeSig = await signSecp256k1(privKey, probe);
    const probePub = await recoverPubkey(probeSig, probe);
    const owner = `0x${toHex(await deriveAddressFromPubkey(probePub))}`;

    const payload = {
      market: 7,
      side: 'Bid',
      size: 1000n,
      limit_px: 42_000n,
      expiry_ms: 1_700_000_000_000,
      stp_group: 3,
    };
    const signed = await signTypedAction(privKey, 'rfq_request', payload, 11n, CHAIN_ID);
    expect(signed.signature.length).toBe(2 + 130);
    const recovered = await recoverTypedSigner(signed, 'rfq_request', payload, CHAIN_ID);
    expect(recovered.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('rejects a non-PascalCase side', async () => {
    const { buildTyped } = await import('../src/native/typed.js');
    expect(() =>
      buildTyped(
        'rfq_request',
        { market: 7, side: 'bid', size: 1000n, expiry_ms: 0 },
        11n,
        CHAIN_ID,
      ),
    ).toThrow(/side must be one of/);
  });
});
