// Unified `placeOrder` — routing, refusals, and byte-identity with the
// per-action builders.
//
// The signature covers the raw action bytes, so a unified call MUST produce the
// same string a hand-built call produces, key order included. These specs pin
// the literal bytes as well as the equivalence, so a reordered field fails here
// instead of 401ing every order on the live chain.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planPlaceOrder, PlaceOrderPartialError } from '../src/native/place.js';
import {
  buildNativeBatchOrderAction,
  buildNativeSpotOrderAction,
} from '../src/native/actions.js';
import type {
  PerpOrderLeg,
  PlaceOrderLeg,
  SpotOrderLeg,
} from '../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBuilt = existsSync(
  resolve(__dirname, '..', 'pkg', 'metaflux_client_wasm.js'),
);

const OWNER = '0x000000000000000000000000000000000000beef';
const VAULT = '0x00000000000000000000000000000000000000aa';
const CLOID = '0x5c00000000000000000000000000000f';

function perpLeg(over: Partial<PerpOrderLeg> = {}): PerpOrderLeg {
  return {
    venue: 'perp',
    owner: OWNER,
    market: 1,
    side: 'bid',
    kind: 'limit',
    size: 1000,
    limit_px: 5_000_000_000_000,
    tif: 'gtc',
    stp_mode: 'cancel_oldest',
    reduce_only: false,
    ...over,
  };
}

function spotLeg(over: Partial<SpotOrderLeg> = {}): SpotOrderLeg {
  return {
    venue: 'spot',
    pair: 7,
    side: 'ask',
    size: 250,
    limit_px: 100_000_000,
    tif: 'ioc',
    stp_mode: 'cancel_newest',
    ...over,
  };
}

function stripVenue<T extends { venue: string }>(leg: T): Omit<T, 'venue'> {
  const { venue: _venue, ...rest } = leg;
  return rest;
}

describe('planPlaceOrder routing', () => {
  it('routes ONE perp order to batch_order', () => {
    const plan = planPlaceOrder(perpLeg());
    expect(plan.route).toBe('batch_order');
    if (plan.route !== 'batch_order') throw new Error('wrong route');
    expect(plan.batch.orders.length).toBe(1);
    expect(plan.actionJson.startsWith('{"type":"batch_order"')).toBe(true);
  });

  it('routes a bare (non-array) perp order the same as a one-element array', () => {
    const single = planPlaceOrder(perpLeg());
    const wrapped = planPlaceOrder([perpLeg()]);
    expect(single.actionJson).toStrictEqual(wrapped.actionJson);
  });

  it('routes SEVERAL perp orders to ONE batch_order', () => {
    const plan = planPlaceOrder([
      perpLeg(),
      perpLeg({ market: 2, side: 'ask' }),
      perpLeg({ market: 3, tif: 'alo' }),
    ]);
    expect(plan.route).toBe('batch_order');
    if (plan.route !== 'batch_order') throw new Error('wrong route');
    expect(plan.batch.orders.length).toBe(3);
    // One action string = one signature = one nonce.
    expect(typeof plan.actionJson).toBe('string');
    expect(plan.actionJson.split('{"owner"').length - 1).toBe(3);
  });

  it('routes spot orders to ONE spot_order action EACH', () => {
    const plan = planPlaceOrder([
      spotLeg(),
      spotLeg({ pair: 8 }),
      spotLeg({ pair: 9 }),
    ]);
    expect(plan.route).toBe('spot_order');
    if (plan.route !== 'spot_order') throw new Error('wrong route');
    expect(plan.orders.length).toBe(3);
    expect(plan.actionJson.length).toBe(3);
    for (const json of plan.actionJson) {
      expect(json.startsWith('{"type":"spot_order"')).toBe(true);
    }
  });

  it('carries owner and grouping onto the batch_order route', () => {
    const plan = planPlaceOrder([perpLeg()], {
      owner: VAULT,
      grouping: 'positionTpsl',
    });
    if (plan.route !== 'batch_order') throw new Error('wrong route');
    expect(plan.batch.owner).toBe(VAULT);
    expect(plan.batch.grouping).toBe('positionTpsl');
  });

  it('does not convert number planes: px and size pass through verbatim', () => {
    const plan = planPlaceOrder(
      perpLeg({ size: '18446744073709551615', limit_px: 12_345_678n }),
    );
    if (plan.route !== 'batch_order') throw new Error('wrong route');
    expect(plan.actionJson).toContain('"size":18446744073709551615');
    expect(plan.actionJson).toContain('"limit_px":12345678');
  });
});

describe('planPlaceOrder refusals', () => {
  it('REFUSES a mixed perp + spot request and names the reason', () => {
    expect(() => planPlaceOrder([perpLeg(), spotLeg()])).toThrow(
      /cannot mix perp and spot/,
    );
  });

  it('refuses a mixed request in either order', () => {
    expect(() => planPlaceOrder([spotLeg(), perpLeg()])).toThrow(
      /cannot mix perp and spot/,
    );
  });

  it('refuses an empty request', () => {
    expect(() => planPlaceOrder([])).toThrow(/at least one order/);
  });

  it('refuses an unknown venue', () => {
    const bogus = { ...spotLeg(), venue: 'futures' } as unknown as PlaceOrderLeg;
    expect(() => planPlaceOrder([bogus])).toThrow(/venue must be/);
  });

  it('refuses a spot leg whose owner differs from opts.owner', () => {
    expect(() => planPlaceOrder([spotLeg({ owner: OWNER })], { owner: VAULT })).toThrow(
      /differs from opts.owner/,
    );
  });

  it('refuses an invalid spot owner address', () => {
    expect(() => planPlaceOrder([spotLeg({ owner: '0xnothex' })])).toThrow(
      /owner must be a 0x-prefixed 20-byte hex address/,
    );
  });

  it('refuses grouping on the spot route', () => {
    expect(() => planPlaceOrder([spotLeg()], { grouping: 'normalTpsl' })).toThrow(
      /grouping is a batch_order field/,
    );
  });

  it('refuses one explicit nonce for several spot orders', () => {
    expect(() => planPlaceOrder([spotLeg(), spotLeg({ pair: 8 })], { nonce: 7n }))
      .toThrow(/each needing its own nonce/);
  });

  it('accepts an explicit nonce for a single spot order', () => {
    expect(() => planPlaceOrder([spotLeg()], { nonce: 7n })).not.toThrow();
  });
});

describe('planPlaceOrder action bytes are byte-identical to the builders', () => {
  it('one perp order == buildNativeBatchOrderAction', () => {
    const leg = perpLeg();
    const plan = planPlaceOrder(leg);
    if (plan.route !== 'batch_order') throw new Error('wrong route');
    expect(plan.actionJson).toStrictEqual(
      buildNativeBatchOrderAction({ orders: [stripVenue(leg)] }),
    );
  });

  it('several perp orders + owner + grouping == buildNativeBatchOrderAction', () => {
    const legs = [
      perpLeg({ cloid: CLOID }),
      perpLeg({ market: 2, side: 'ask', reduce_only: true }),
    ];
    const plan = planPlaceOrder(legs, { owner: VAULT, grouping: 'normalTpsl' });
    if (plan.route !== 'batch_order') throw new Error('wrong route');
    expect(plan.actionJson).toStrictEqual(
      buildNativeBatchOrderAction({
        owner: VAULT,
        orders: legs.map(stripVenue),
        grouping: 'normalTpsl',
      }),
    );
  });

  it('each spot order == buildNativeSpotOrderAction', () => {
    const legs = [spotLeg({ cloid: CLOID }), spotLeg({ pair: 8, side: 'bid' })];
    const plan = planPlaceOrder(legs);
    if (plan.route !== 'spot_order') throw new Error('wrong route');
    expect(plan.actionJson).toStrictEqual(
      legs.map((l) => buildNativeSpotOrderAction(stripVenue(l))),
    );
  });

  // The digest covers these bytes verbatim, so key ORDER is part of the
  // signature. Pin the literal string.
  it('pins the batch_order field order', () => {
    const plan = planPlaceOrder([perpLeg()]);
    expect(plan.actionJson).toBe(
      '{"type":"batch_order","params":{"orders":[{"owner":"0x000000000000000000000000000000000000beef",' +
        '"market":1,"side":"bid","kind":"limit","size":1000,"limit_px":5000000000000,"tif":"gtc",' +
        '"stp_mode":"cancel_oldest","reduce_only":false}],"grouping":"na"}}',
    );
  });

  it('pins the batch_order field order with a top-level owner (owner first)', () => {
    const plan = planPlaceOrder([perpLeg()], { owner: VAULT });
    expect(plan.actionJson).toBe(
      '{"type":"batch_order","params":{"owner":"0x00000000000000000000000000000000000000aa",' +
        '"orders":[{"owner":"0x000000000000000000000000000000000000beef","market":1,"side":"bid",' +
        '"kind":"limit","size":1000,"limit_px":5000000000000,"tif":"gtc","stp_mode":"cancel_oldest",' +
        '"reduce_only":false}],"grouping":"na"}}',
    );
  });

  it('pins the spot_order field order', () => {
    const plan = planPlaceOrder([spotLeg()]);
    if (plan.route !== 'spot_order') throw new Error('wrong route');
    expect(plan.actionJson[0]).toBe(
      '{"type":"spot_order","order":{"pair":7,"side":"ask","size":250,"limit_px":100000000,' +
        '"tif":"ioc","stp_mode":"cancel_newest"}}',
    );
  });

  it('pins the spot_order field order with opts.owner (owner first)', () => {
    const plan = planPlaceOrder([spotLeg()], { owner: VAULT });
    if (plan.route !== 'spot_order') throw new Error('wrong route');
    expect(plan.orders[0]?.owner).toBe(VAULT);
    expect(plan.actionJson[0]).toBe(
      '{"type":"spot_order","order":{"owner":"0x00000000000000000000000000000000000000aa",' +
        '"pair":7,"side":"ask","size":250,"limit_px":100000000,"tif":"ioc",' +
        '"stp_mode":"cancel_newest"}}',
    );
  });

  it('applies opts.owner to EVERY spot leg', () => {
    const plan = planPlaceOrder([spotLeg(), spotLeg({ pair: 8 })], { owner: VAULT });
    if (plan.route !== 'spot_order') throw new Error('wrong route');
    for (const json of plan.actionJson) {
      expect(json).toContain(`"order":{"owner":"${VAULT}"`);
    }
  });

  it('a per-leg owner == opts.owner produces the same bytes', () => {
    const viaOpts = planPlaceOrder([spotLeg()], { owner: VAULT });
    const viaLeg = planPlaceOrder([spotLeg({ owner: VAULT })]);
    expect(viaOpts.actionJson).toStrictEqual(viaLeg.actionJson);
  });

  it('drops the venue tag from the signed bytes', () => {
    expect(planPlaceOrder([perpLeg()]).actionJson).not.toContain('venue');
    expect(planPlaceOrder([spotLeg()]).actionJson[0]).not.toContain('venue');
  });
});

// The venue split is a TYPE guarantee, not a runtime check. `tsc` runs over
// this file (tsconfig.test.json), so a `@ts-expect-error` that stops erroring
// fails the typecheck gate.
describe('the venue tag splits the leg shapes at compile time', () => {
  it('rejects a perp-only field on a spot leg', () => {
    const bad = {
      venue: 'spot',
      pair: 7,
      side: 'ask',
      size: 250,
      limit_px: 100_000_000,
      tif: 'ioc',
      stp_mode: 'cancel_newest',
      // @ts-expect-error spot has no positions, so no reduce_only
      reduce_only: false,
    } satisfies SpotOrderLeg;
    expect(bad.pair).toBe(7);
  });

  it('rejects the spot key on a perp leg', () => {
    const bad = {
      venue: 'perp',
      owner: OWNER,
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
      // @ts-expect-error perp keys on `market`; `pair` is the spot id space
      pair: 7,
    } satisfies PerpOrderLeg;
    expect(bad.market).toBe(1);
  });

  it('refuses to read a route payload before narrowing', () => {
    const result = planPlaceOrder(perpLeg()) as ReturnType<typeof planPlaceOrder>;
    // @ts-expect-error `batch` exists on the batch route only
    void result.batch;
    expect(result.route).toBe('batch_order');
  });
});

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function signerAddress(privKey: Uint8Array): Promise<string> {
  const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
    await import('../src/wallet/wasm.js');
  const probeDigest = await keccak256(new TextEncoder().encode('probe'));
  const probeSig = await signSecp256k1(privKey, probeDigest);
  const probePub = await recoverPubkey(probeSig, probeDigest);
  return `0x${toHex(await deriveAddressFromPubkey(probePub))}`;
}

describe.skipIf(!wasmBuilt)('Client.placeOrder submission', () => {
  const PRIV = new Uint8Array(32).fill(0x4f);
  let bodies: string[] = [];
  let reply: () => { ok: boolean; status: number; body: string };
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    bodies = [];
    reply = () => ({ ok: true, status: 200, body: '{"statuses":[]}' });
    savedFetch = globalThis.fetch;
    // The WASM loader fetches pkg/*.wasm through this same global, so record
    // only the `/exchange` posts.
    globalThis.fetch = vi.fn(
      async (url: unknown, init: { body?: unknown } = {}) => {
        if (!String(url).includes('/exchange')) {
          return savedFetch(url as RequestInfo, init as RequestInit);
        }
        bodies.push(String(init.body ?? ''));
        const r = reply();
        return {
          ok: r.ok,
          status: r.status,
          text: async () => r.body,
        } as Response;
      },
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  async function client() {
    const { Client } = await import('../src/client.js');
    return new Client({ baseUrl: 'http://localhost:0', privateKey: PRIV });
  }

  it('sends ONE batch_order POST for several perp orders', async () => {
    const owner = await signerAddress(PRIV);
    reply = () => ({
      ok: true,
      status: 200,
      body: '{"statuses":[{"resting":{"oid":11}},{"filled":{"oid":12,"total_sz":"1.5","avg_px":"50000.0"}}]}',
    });
    const c = await client();
    const result = await c.placeOrder([
      perpLeg({ owner, cloid: CLOID }),
      perpLeg({ owner, market: 2 }),
    ]);

    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain('batch_order');
    if (result.route !== 'batch_order') throw new Error('wrong route');
    expect(result.legs.length).toBe(2);
    expect(result.legs[0]?.cloid).toBe(CLOID);
    expect(result.legs[0]?.status).toStrictEqual({ resting: { oid: 11 } });
    expect(result.legs[1]?.status).toStrictEqual({
      filled: { oid: 12, total_sz: '1.5', avg_px: '50000.0' },
    });
  });

  it('sends ONE spot_order POST PER spot order', async () => {
    reply = () => ({ ok: true, status: 200, body: '{"statuses":[{"resting":{"oid":5}}]}' });
    const c = await client();
    const result = await c.placeOrder([
      spotLeg(),
      spotLeg({ pair: 8 }),
      spotLeg({ pair: 9 }),
    ]);

    expect(bodies.length).toBe(3);
    for (const body of bodies) expect(body).toContain('spot_order');
    if (result.route !== 'spot_order') throw new Error('wrong route');
    expect(result.submissions.length).toBe(3);
    expect(result.submissions.map((s) => s.state)).toStrictEqual([
      'sent',
      'sent',
      'sent',
    ]);
  });

  it('gives each spot action its own nonce', async () => {
    const c = await client();
    await c.placeOrder([spotLeg(), spotLeg({ pair: 8 })]);
    const nonces = bodies.map((b) => (JSON.parse(b) as { nonce: number }).nonce);
    expect(nonces.length).toBe(2);
    expect(new Set(nonces).size).toBe(2);
  });

  it('stops the spot run at the first failure and reports what was sent', async () => {
    let call = 0;
    reply = () => {
      call += 1;
      return call === 2
        ? { ok: false, status: 400, body: '{"error":"insufficient balance"}' }
        : { ok: true, status: 200, body: '{"statuses":[{"resting":{"oid":5}}]}' };
    };
    const c = await client();

    let caught: unknown;
    try {
      await c.placeOrder([spotLeg(), spotLeg({ pair: 8 }), spotLeg({ pair: 9 })]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlaceOrderPartialError);
    if (!(caught instanceof PlaceOrderPartialError)) throw new Error('no throw');
    // The third action is never sent.
    expect(bodies.length).toBe(2);
    expect(caught.result.route).toBe('spot_order');
    expect(caught.result.submissions.map((s) => s.state)).toStrictEqual([
      'sent',
      'failed',
      'not_sent',
    ]);
    expect(caught.message).toContain('may already be committed');
  });

  it('refuses a mixed request before any POST', async () => {
    const owner = await signerAddress(PRIV);
    const c = await client();
    await expect(
      c.placeOrder([perpLeg({ owner }), spotLeg()]),
    ).rejects.toThrow(/cannot mix perp and spot/);
    expect(bodies.length).toBe(0);
  });

  // The POST embeds the signed action bytes verbatim, so the plan is a true
  // dry run of what reaches the chain.
  it('posts the exact bytes the plan predicted', async () => {
    const owner = await signerAddress(PRIV);
    const c = await client();
    const legs = [perpLeg({ owner }), perpLeg({ owner, market: 4 })];
    await c.placeOrder(legs);
    expect(String(bodies[0])).toContain(planPlaceOrder(legs).actionJson);
  });
});
