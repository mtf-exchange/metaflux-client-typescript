// Faucet helper tests — pure TS, mocks global fetch.
// Asserts `requestFaucet` POSTs `{ address, amount? }` to the SEPARATE faucet
// origin's `/faucet` path, decodes the `{ address, amount, status }` success body,
// and maps a 429 rate-limit `{ error }` envelope to a `MetaFluxApiError`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestFaucet } from '../src/faucet.js';
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

// The faucet runs on its OWN origin (devnet node port 8082), NOT the trading
// API base URL.
const FAUCET = 'http://localhost:8082';
const ADDR = '0x000000000000000000000000000000000000beef';

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
          JSON.stringify({ address: ADDR, amount: 1000, status: 'queued' }),
      } as Response;
    }) as typeof fetch;
  });

  it('POSTs {address, amount} to the faucet origin /faucet and decodes the body', async () => {
    const res = await requestFaucet(FAUCET, ADDR, 1000);
    expect(captured?.url).toBe('http://localhost:8082/faucet');
    expect(captured?.method).toBe('POST');
    expect(captured?.contentType).toBe('application/json');
    expect(JSON.parse(captured!.body)).toEqual({ address: ADDR, amount: 1000 });
    expect(res).toEqual({ address: ADDR, amount: 1000, status: 'queued' });
  });

  it('omits `amount` when not supplied (full default grant)', async () => {
    await requestFaucet(FAUCET, ADDR);
    expect(JSON.parse(captured!.body)).toEqual({ address: ADDR });
    expect(captured!.body).not.toContain('amount');
  });
});

describe('requestFaucet errors', () => {
  it('maps a 429 rate-limit envelope to MetaFluxApiError', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: 'already funded: address already funded',
          }),
      }) as Response) as typeof fetch;

    await expect(requestFaucet(FAUCET, ADDR)).rejects.toThrow(
      MetaFluxApiError,
    );
    await expect(requestFaucet(FAUCET, ADDR)).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('already funded'),
    });
  });
});
