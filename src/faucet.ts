// Devnet / testnet faucet helper.
//
// The node exposes a faucet at `POST <faucetBaseUrl>/faucet` that credits an
// address with test USDC + MTF. It runs on its OWN origin (devnet node port 8080;
// production `https://faucet.devnet.mtf.exchange`), SEPARATE from the trading
// API base URL — so `requestFaucet` takes a dedicated `faucetBaseUrl` rather
// than reusing a `Client`'s trading base URL.
//
// The grant is staged for the NEXT block: a 200 response carries
// `status: "queued"` and the credited balance lands after ~1 block, not
// synchronously. Devnet / testnet only — mainnet refuses (surfaced as a
// `MetaFluxApiError`).

import { httpRequest } from './http.js';

/// Successful faucet response (200). `status` is `"queued"` — the credit is
/// staged for the next block, so the balance updates after ~1 block rather
/// than synchronously.
export interface FaucetResponse {
  /// Echo of the credited address (`0x`-prefixed 20-byte hex).
  address: string;
  /// Whole-USDC cross-collateral granted (capped server-side, default 3000).
  usdc: number;
  /// MTF spot tokens granted (fixed, default 10).
  mtf: number;
  /// Always `"queued"` — credit staged for the next block.
  status: string;
}

/// Request test USDC from a devnet / testnet faucet.
///
/// POSTs `{ address, amount? }` to `<faucetBaseUrl>/faucet` (grants both USDC and MTF). `amount` is a
/// whole-USDC integer; omit it for the faucet's full default grant (capped
/// server-side).
///
/// `faucetBaseUrl` is the faucet's OWN origin (e.g. `http://localhost:8080`
/// on devnet, `https://faucet.devnet.mtf.exchange` in production) — NOT the
/// trading API base URL.
///
/// On success the credit is `"queued"` for the next block; the balance updates
/// after ~1 block, not synchronously.
///
/// Throws `MetaFluxApiError` on a non-2xx status, surfacing the server's
/// `{ error }` message — notably 429 (rate-limited: per-address once-ever, per-IP
/// 1/minute), 400 (bad/zero address), 503 (backlog full), or a mainnet refusal.
export async function requestFaucet(
  faucetBaseUrl: string,
  address: string,
  amount?: number,
): Promise<FaucetResponse> {
  const json: { address: string; amount?: number } = { address };
  if (amount !== undefined) {
    json.amount = amount;
  }
  return httpRequest<FaucetResponse>(faucetBaseUrl, '/faucet', {
    method: 'POST',
    json,
  });
}
