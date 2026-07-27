// Agent authorization on the owner-carrying write paths.
//
// The node admits two signers for an action that names an `owner`: the owner
// itself, and any agent the owner approved. The client must admit exactly the
// same pair. A client that is stricter blocks a legal agent order; a client
// that is looser burns a nonce on an action the node rejects.
//
// Every spec here drives the real `Client` over a mocked `fetch`, so it pins
// the observable behaviour: which requests leave, and which throw first.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NativeCancel, NativeOrder } from '../src/types/index.js';
import type { AgentEntry } from '../src/types/info/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBuilt = existsSync(
  resolve(__dirname, '..', 'pkg', 'metaflux_client_wasm.js'),
);

const MASTER_PRIV = new Uint8Array(32).fill(0x11);
const AGENT_PRIV = new Uint8Array(32).fill(0x22);
const STRANGER = '0x00000000000000000000000000000000deadbeef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/// Upper-case the 20 hex bytes, keep the `0x` prefix the address validator wants.
function upperHex(addr: string): string {
  return `0x${addr.slice(2).toUpperCase()}`;
}

async function signerAddress(privKey: Uint8Array): Promise<string> {
  const { deriveAddressFromPubkey, recoverPubkey, signSecp256k1, keccak256 } =
    await import('../src/wallet/wasm.js');
  const probeDigest = await keccak256(new TextEncoder().encode('probe'));
  const probeSig = await signSecp256k1(privKey, probeDigest);
  const probePub = await recoverPubkey(probeSig, probeDigest);
  return `0x${toHex(await deriveAddressFromPubkey(probePub))}`;
}

describe.skipIf(!wasmBuilt)('Client agent authorization', () => {
  let exchangeBodies: string[] = [];
  let infoBodies: string[] = [];
  let agentsReply: () => { ok: boolean; status: number; body: string };
  let savedFetch: typeof globalThis.fetch;

  function approved(agents: AgentEntry[]): {
    ok: boolean;
    status: number;
    body: string;
  } {
    return {
      ok: true,
      status: 200,
      body: JSON.stringify({
        type: 'agents',
        data: { address: '0x0', agents },
      }),
    };
  }

  beforeEach(() => {
    exchangeBodies = [];
    infoBodies = [];
    agentsReply = () => approved([]);
    savedFetch = globalThis.fetch;
    // The WASM loader fetches pkg/*.wasm through this same global, so pass
    // anything that is not an API route straight through.
    globalThis.fetch = vi.fn(
      async (url: unknown, init: { body?: unknown } = {}) => {
        const target = String(url);
        if (target.includes('/exchange')) {
          exchangeBodies.push(String(init.body ?? ''));
          return {
            ok: true,
            status: 200,
            text: async () => '{"statuses":[]}',
          } as Response;
        }
        if (target.includes('/info')) {
          infoBodies.push(String(init.body ?? ''));
          const r = agentsReply();
          return {
            ok: r.ok,
            status: r.status,
            text: async () => r.body,
          } as Response;
        }
        return savedFetch(url as RequestInfo, init as RequestInit);
      },
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  async function client(privateKey: Uint8Array) {
    const { Client } = await import('../src/client.js');
    return new Client({ baseUrl: 'http://localhost:0', privateKey });
  }

  function order(owner: string): NativeOrder {
    return {
      owner,
      market: 1,
      side: 'bid',
      kind: 'limit',
      size: 1000,
      limit_px: 5_000_000_000_000,
      tif: 'gtc',
      stp_mode: 'cancel_oldest',
      reduce_only: false,
    };
  }

  function cancel(owner: string): NativeCancel {
    return { owner, market: 1, oid: 42 };
  }

  it('lets an APPROVED AGENT place an order for its master', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent, expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await c.submitOrderNative(order(master));

    expect(exchangeBodies.length).toBe(1);
    expect(exchangeBodies[0]).toContain(master.toLowerCase());
    expect(infoBodies.length).toBe(1);
    expect(JSON.parse(infoBodies[0]!)).toEqual({
      type: 'agents',
      address: master,
    });
  });

  it('lets an APPROVED AGENT cancel an order for its master', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent, name: 'bot', expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await c.cancelOrderNative(cancel(master));

    expect(exchangeBodies.length).toBe(1);
  });

  it('matches an approved agent case-insensitively', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent: upperHex(agent), expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await c.submitOrderNative(order(upperHex(master)));

    expect(exchangeBodies.length).toBe(1);
  });

  it('throws locally when the signer is neither the owner nor an agent', async () => {
    const c = await client(AGENT_PRIV);
    await expect(c.submitOrderNative(order(STRANGER))).rejects.toThrow(
      /neither that account nor one of its approved agents/,
    );
    // The action never reaches the wire, so it burns no nonce.
    expect(exchangeBodies.length).toBe(0);
    expect(infoBodies.length).toBe(1);
  });

  it('names both addresses in the refusal so a typo is findable', async () => {
    const agent = await signerAddress(AGENT_PRIV);
    const c = await client(AGENT_PRIV);
    await expect(c.submitOrderNative(order(STRANGER))).rejects.toThrow(
      new RegExp(`signer ${agent}.*owner ${STRANGER}`, 'i'),
    );
  });

  it('accepts a self-signed order without reading /info', async () => {
    const master = await signerAddress(MASTER_PRIV);
    // Any /info read would answer "not approved" here, so a client that asks
    // would refuse the owner its own order.
    agentsReply = () => approved([]);

    const c = await client(MASTER_PRIV);
    await c.submitOrderNative(order(master));

    expect(exchangeBodies.length).toBe(1);
    expect(infoBodies.length).toBe(0);
  });

  it('FAILS OPEN when /info is unreachable, leaving the node the authority', async () => {
    const master = await signerAddress(MASTER_PRIV);
    agentsReply = () => ({ ok: false, status: 503, body: 'gateway down' });

    const c = await client(AGENT_PRIV);
    await c.submitOrderNative(order(master));

    expect(infoBodies.length).toBe(1);
    expect(exchangeBodies.length).toBe(1);
  });

  it('does NOT cache a refusal, so a fresh approval takes effect at once', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([]);

    const c = await client(AGENT_PRIV);
    await expect(c.submitOrderNative(order(master))).rejects.toThrow(
      /approved agents/,
    );

    agentsReply = () => approved([{ agent, expires_at: null }]);
    await c.submitOrderNative(order(master));

    expect(exchangeBodies.length).toBe(1);
    expect(infoBodies.length).toBe(2);
  });

  it('caches an approval, so a second order reads /info once only', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent, expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await c.submitOrderNative(order(master));
    await c.submitOrderNative(order(master));

    expect(exchangeBodies.length).toBe(2);
    expect(infoBodies.length).toBe(1);
  });

  it('authorizes a batch under its TOP-LEVEL owner', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent, expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await c.batchOrder({ owner: master, orders: [order(master), order(master)] });

    expect(exchangeBodies.length).toBe(1);
    expect(infoBodies.length).toBe(1);
  });

  it('throws when a batch leg names an account other than the actor', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent, expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await expect(
      c.batchOrder({ owner: master, orders: [order(master), order(STRANGER)] }),
    ).rejects.toThrow(/batch_order item 1 owner .* is not the acting account/);
    expect(exchangeBodies.length).toBe(0);
  });

  it('throws when a batch_cancel leg names an account other than the actor', async () => {
    const master = await signerAddress(MASTER_PRIV);
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([{ agent, expires_at: null }]);

    const c = await client(AGENT_PRIV);
    await expect(
      c.batchCancel({ owner: master, cancels: [cancel(STRANGER)] }),
    ).rejects.toThrow(/batch_cancel item 0 owner .* is not the acting account/);
    expect(exchangeBodies.length).toBe(0);
  });

  it('takes the SIGNER as the actor when a batch names no owner', async () => {
    const agent = await signerAddress(AGENT_PRIV);
    agentsReply = () => approved([]);

    const c = await client(AGENT_PRIV);
    await c.batchOrder({ orders: [order(agent)] });

    expect(exchangeBodies.length).toBe(1);
    expect(infoBodies.length).toBe(0);
  });
});
