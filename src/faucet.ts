// Devnet / testnet faucet helper.
//
// The node exposes a faucet at `POST <faucetBaseUrl>/faucet` that credits an
// address with test USDC + MTF. It runs on its OWN origin (devnet node port 8080;
// production `https://api.testnet.mtf.exchange/faucet`), SEPARATE from the trading
// API base URL — so `requestFaucet` takes a dedicated `faucetBaseUrl` rather
// than reusing a `Client`'s trading base URL.
//
// The grant is staged for the NEXT block: a 200 response carries
// `status: "queued"` and the credited balance lands after ~1 block, not
// synchronously. Devnet / testnet only — mainnet refuses (surfaced as a
// `MetaFluxApiError`).

import { httpRequest } from './rest/http.js';

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
/// **A partial `amount` FORFEITS the rest of the grant.** The faucet pays an
/// address once, ever. `amount: 1` takes 1 USDC and forfeits the other 2999.
/// The MTF grant is fixed at 10 and `amount` never scales it, so that lane
/// always pays in full and then closes. Omit `amount` to take the full grant.
/// NOT LIVE YET — read the 429 note below for what the live chain does today.
///
/// `faucetBaseUrl` is the faucet's OWN origin (e.g. `http://localhost:8080`
/// on devnet, `https://api.testnet.mtf.exchange/faucet` in production) — NOT the
/// trading API base URL.
///
/// On success the credit is `"queued"` for the next block; the balance updates
/// after ~1 block, not synchronously.
///
/// Throws `MetaFluxApiError` on a non-2xx status, surfacing the server's
/// `{ error }` message — notably 429 (rate-limited), 400 (bad/zero address),
/// 503 (backlog full), or a mainnet refusal.
///
/// Two rules answer 429. The per-address rule is committed chain state: the
/// first claim of any size closes the address, so the refusal survives a
/// faucet-node restart and answers `{"error":"address already funded"}`.
/// The per-IP rule is one grant per IP per day. That window is NODE-LOCAL and it resets when the
/// faucet node restarts, and a release restarts it — so read it as a speed
/// bump, not as an anti-sybil control. The per-address rule and the reserve
/// balance bound the payout.
///
/// NOT LIVE YET. Both rules take the form above with the next node release.
/// Today the live chain allows one grant per IP per MINUTE. It also lets an
/// address that claimed a partial `amount` claim again after the faucet node
/// restarts, because the old per-address rule counts VALUE against a cap.
/// Build against the rules above; do not depend on the live behaviour.
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
