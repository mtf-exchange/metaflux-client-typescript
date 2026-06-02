// MTF-native /info request-shape tests — pure TS, no WASM. Mocks global fetch
// and asserts each InfoApi method POSTs the EXACT `{"type": ...}` body the
// server handler (`metaflux/crates/api-node/src/rest/info.rs::handle_info`)
// dispatches on, and decodes the response.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InfoApi } from '../src/info.js';

interface Captured {
  url: string;
  method: string;
  body: string;
  contentType: string | null;
}

let captured: Captured | undefined;
let nextResponse: unknown = {};

const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = undefined;
  nextResponse = {};
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
      text: async () => JSON.stringify(nextResponse),
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const BASE = 'http://localhost:8080';

describe('InfoApi request shapes', () => {
  it('nodeInfo POSTs {"type":"node_info"} to /info', async () => {
    const api = new InfoApi(BASE);
    nextResponse = { chain_id: 998, epoch: 1, height: 2, peers_connected: 3 };
    const res = await api.nodeInfo();
    expect(captured?.url).toBe('http://localhost:8080/info');
    expect(captured?.method).toBe('POST');
    expect(captured?.contentType).toBe('application/json');
    expect(JSON.parse(captured!.body)).toEqual({ type: 'node_info' });
    expect(res.chain_id).toBe(998);
  });

  it('accountState sends account_id (numeric, not address)', async () => {
    const api = new InfoApi(BASE);
    nextResponse = {
      account_id: 42,
      position_count: 0,
      balance_base: 0,
      balance_quote: 0,
    };
    await api.accountState(42);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'account_state',
      account_id: 42,
    });
  });

  it('marketInfo sends market_id', async () => {
    const api = new InfoApi(BASE);
    nextResponse = { market_id: 7, mark_px: '0', last_trade_ms: 0, oi: '0' };
    const res = await api.marketInfo(7);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'market_info',
      market_id: 7,
    });
    // mark_px / oi are strings on the wire (may exceed 2^53).
    expect(typeof res.mark_px).toBe('string');
    expect(typeof res.oi).toBe('string');
  });

  it('vaultState sends vault_id', async () => {
    const api = new InfoApi(BASE);
    await api.vaultState(99);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'vault_state',
      vault_id: 99,
    });
  });

  it('stakingState sends account_id', async () => {
    const api = new InfoApi(BASE);
    await api.stakingState(7);
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'staking_state',
      account_id: 7,
    });
  });

  it('feeSchedule POSTs {"type":"fee_schedule"}', async () => {
    const api = new InfoApi(BASE);
    await api.feeSchedule();
    expect(JSON.parse(captured!.body)).toEqual({ type: 'fee_schedule' });
  });

  it('raw passes an arbitrary typed body through', async () => {
    const api = new InfoApi(BASE);
    await api.raw({ type: 'some_future_query', foo: 1 });
    expect(JSON.parse(captured!.body)).toEqual({
      type: 'some_future_query',
      foo: 1,
    });
  });
});
