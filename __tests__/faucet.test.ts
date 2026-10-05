// Faucet helper tests — mocks global fetch.
// Asserts the signed claim (message text, a known-answer signature shared with
// the Rust SDK), the `{ address, expires, signature }` body posted to
// the SEPARATE faucet origin's `/faucet` path, and the refusal mapping.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAUCET_CLAIM_TTL_SECS,
  faucetClaimMessage,
  requestFaucet,
  signFaucetClaim,
} from '../src/faucet.js';
import { MetaFluxApiError } from '../src/rest/http.js';

interface Captured {
  url: string;
  method: string;
  body: string;
  contentType: string | null;
}

let captured: Captured | undefined;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FAUCET = 'http://localhost:8082';

// The EIP-155 specification's example key. Public, so never fund it.
const KAT_KEY = new Uint8Array(32).fill(0x46);
const KAT_ADDRESS = '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f';
const KAT_EXPIRES = 1_791_000_300;
// Computed with @noble/curves; the Rust SDK asserts the same value.
const KAT_SIGNATURE =
  '0x40cc298fe68bb92f1cc2877f7840a0be5332c8db90b840ba830d8b8a3c7c114c547db1a452ec9a05d8e522fb3607a7b8fe0edb8a7e50455fdf65e4e44e47c5d41c';

describe('faucet claim signing', () => {
  it('builds the four-line message with a lowercase 0x address', () => {
    expect(
      faucetClaimMessage(
        '9D8A62F656A8D1615C1294FD71E9CFB3E4855A4F',
        114514,
        KAT_EXPIRES,
      ),
    ).toBe(
      'MetaFlux faucet claim\naddress: 0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f\nchain: 114514\nexpires: 1791000300',
    );
  });

  it('refuses a malformed address', () => {
    expect(() => faucetClaimMessage('0xbeef', 114514, KAT_EXPIRES)).toThrow(
      RangeError,
    );
  });

  it('matches the known-answer signature', async () => {
    await expect(signFaucetClaim(KAT_KEY, 114514, KAT_EXPIRES)).resolves.toEqual(
      { address: KAT_ADDRESS, expires: KAT_EXPIRES, signature: KAT_SIGNATURE },
    );
  });

  it('signs the chain id', async () => {
    const devnet = await signFaucetClaim(KAT_KEY, 31337, KAT_EXPIRES);
    expect(devnet.signature).not.toBe(KAT_SIGNATURE);
  });
});

describe('requestFaucet', () => {
  beforeEach(() => {
    captured = undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      captured = {
        url: String(url),
        method: init.method ?? 'GET',
        body: String(init.body),
        contentType: headers.get('Content-Type'),
      };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            address: KAT_ADDRESS,
            usdc: 3000,
            mtf: 10,
            status: 'queued',
          }),
      } as Response;
    }) as typeof fetch;
  });

  it('signs with a private key and POSTs the claim to the faucet origin', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await requestFaucet(FAUCET, KAT_KEY);
    expect(captured?.url).toBe('http://localhost:8082/faucet');
    expect(captured?.method).toBe('POST');
    expect(captured?.contentType).toBe('application/json');
    const body = JSON.parse(captured!.body);
    expect(Object.keys(body).sort()).toEqual(['address', 'expires', 'signature']);
    expect(body.address).toBe(KAT_ADDRESS);
    expect(body.expires).toBeGreaterThanOrEqual(before + FAUCET_CLAIM_TTL_SECS);
    expect(body.expires).toBeLessThanOrEqual(before + FAUCET_CLAIM_TTL_SECS + 5);
    const resigned = await signFaucetClaim(KAT_KEY, 114514, body.expires);
    expect(body.signature).toBe(resigned.signature);
    expect(res).toEqual({
      address: KAT_ADDRESS,
      usdc: 3000,
      mtf: 10,
      status: 'queued',
    });
  });

  it('signs for the chain it is given', async () => {
    await requestFaucet(FAUCET, KAT_KEY, 31337);
    const body = JSON.parse(captured!.body);
    const devnet = await signFaucetClaim(KAT_KEY, 31337, body.expires);
    expect(body.signature).toBe(devnet.signature);
  });

  it('sends a precomputed claim as is', async () => {
    const claim = {
      address: KAT_ADDRESS,
      expires: KAT_EXPIRES,
      signature: KAT_SIGNATURE,
    };
    await requestFaucet(FAUCET, claim);
    expect(JSON.parse(captured!.body)).toEqual(claim);
  });
});

describe('requestFaucet errors', () => {
  it('keeps the refusal text', async () => {
    const refusal = 'faucet claim signature does not match the address';
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: refusal }),
      }) as Response) as typeof fetch;

    await expect(requestFaucet(FAUCET, KAT_KEY)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(new RegExp(`: ${refusal}$`)),
    });
  });

  it('maps a 429 rate-limit envelope to MetaFluxApiError', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'address already funded' }),
      }) as Response) as typeof fetch;

    await expect(requestFaucet(FAUCET, KAT_KEY)).rejects.toThrow(
      MetaFluxApiError,
    );
    await expect(requestFaucet(FAUCET, KAT_KEY)).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('already funded'),
    });
  });
});
