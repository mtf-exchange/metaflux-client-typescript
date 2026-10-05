// Devnet / testnet faucet helper.
//
// The node exposes a faucet at `POST <faucetBaseUrl>/faucet` that credits an
// address with test USDC + MTF. The testnet gateway serves it at
// `https://api.testnet.mtf.exchange/faucet`. A devnet node serves it on its own
// port, so `requestFaucet` takes a dedicated `faucetBaseUrl` rather than reusing
// a `Client`'s trading base URL.
//
// The recipient signs every claim: an EIP-191 `personal_sign` over
// `faucetClaimMessage`, so the address that receives the grant is the address
// that asked for it.
//
// The grant is staged for the NEXT block: a 200 response carries
// `status: "queued"` and the credited balance lands after ~1 block, not
// synchronously. Devnet / testnet only — mainnet refuses (surfaced as a
// `MetaFluxApiError`).

import { httpRequest } from './rest/http.js';
import { CHAIN_ID, toHex, validateAddress } from './native/digest.js';
import {
  deriveAddressFromPubkey,
  keccak256,
  recoverPubkey,
  signSecp256k1,
} from './wallet/wasm.js';

/// How long a claim signed by `signFaucetClaim` stays valid, in seconds. The
/// node refuses an `expires` in the past and one more than 600 s ahead of its
/// own clock.
export const FAUCET_CLAIM_TTL_SECS = 300;

/// Successful faucet response (200). `status` is `"queued"` — the credit is
/// staged for the next block, so the balance updates after ~1 block rather
/// than synchronously.
export interface FaucetResponse {
  /// Echo of the credited address (`0x`-prefixed 20-byte hex).
  address: string;
  /// Whole-USDC cross-collateral granted (fixed, default 3000).
  usdc: number;
  /// MTF spot tokens granted (fixed, default 10).
  mtf: number;
  /// Always `"queued"` — credit staged for the next block.
  status: string;
}

/// The signed fields of a faucet request.
export interface FaucetClaim {
  /// The recipient, `0x`-prefixed. It is also the signer.
  address: string;
  /// Unix seconds after which the node refuses the claim.
  expires: number;
  /// `0x`-prefixed 65-byte `r || s || v` hex, with `v` 27 or 28.
  signature: string;
}

/// The exact text the recipient signs with `personal_sign`: four lines joined
/// by `\n`, with no trailing newline. A browser wallet signs this string; pass
/// the result to `requestFaucet` as a `FaucetClaim`.
export function faucetClaimMessage(
  address: string,
  chainId: number,
  expires: number,
): string {
  validateAddress(address, 'address');
  const addr = address.toLowerCase().replace(/^(0x)?/, '0x');
  return `MetaFlux faucet claim\naddress: ${addr}\nchain: ${chainId}\nexpires: ${expires}`;
}

/// Sign a faucet claim for the private key's own address. `expires` defaults
/// to now + `FAUCET_CLAIM_TTL_SECS`.
export async function signFaucetClaim(
  privateKey: Uint8Array,
  chainId: number = CHAIN_ID,
  expires: number = Math.floor(Date.now() / 1000) + FAUCET_CLAIM_TTL_SECS,
): Promise<FaucetClaim> {
  if (privateKey.length !== 32) {
    throw new RangeError('privateKey must be exactly 32 bytes');
  }
  // The WASM module has no key-to-pubkey call, so recover the pubkey from a probe signature.
  const probe = new Uint8Array(32).fill(1);
  const pubkey = await recoverPubkey(await signSecp256k1(privateKey, probe), probe);
  const address = `0x${toHex(await deriveAddressFromPubkey(pubkey))}`;

  const message = new TextEncoder().encode(
    faucetClaimMessage(address, chainId, expires),
  );
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${message.length}`,
  );
  const prefixed = new Uint8Array(prefix.length + message.length);
  prefixed.set(prefix);
  prefixed.set(message, prefix.length);
  const sig = await signSecp256k1(privateKey, await keccak256(prefixed));
  sig[64] = (sig[64] ?? 0) + 27;
  return { address, expires, signature: `0x${toHex(sig)}` };
}

/// Request test USDC from a devnet / testnet faucet.
///
/// `signer` is either the recipient's 32-byte private key, which signs the
/// claim here for `chainId`, or a `FaucetClaim` that a wallet already signed
/// over `faucetClaimMessage`. POSTs `{ address, expires, signature }` to
/// `<faucetBaseUrl>/faucet`. The grant is fixed: 3000 USDC and 10 MTF, once per
/// address, ever.
///
/// **The recipient must hold at least 0.01 ETH on Ethereum mainnet.** The node
/// refuses any other address. Show the refusal message to the user as it is.
///
/// `faucetBaseUrl` is the origin that serves `/faucet`: `http://localhost:8080`
/// on devnet, `https://api.testnet.mtf.exchange` on testnet.
///
/// Throws `MetaFluxApiError` on a non-2xx status. Its `message` ends with the
/// server's `{ error }` text, and `bodyText` holds the raw body. Show the text
/// as it is, and do not match on it. 400 refuses a bad address and a missing,
/// malformed or expired claim. 403 refuses a signature from another wallet and
/// a recipient under the 0.01 ETH balance. 429 refuses an address that already
/// claimed, the per-IP window and too many balance checks from one IP. 503
/// answers an empty reserve, a full backlog and a balance check that cannot
/// run now.
///
/// The per-IP limits live in the faucet node's memory and reset when it
/// restarts, so read them as a speed bump, not as an anti-sybil control.
export async function requestFaucet(
  faucetBaseUrl: string,
  signer: Uint8Array | FaucetClaim,
  chainId: number = CHAIN_ID,
): Promise<FaucetResponse> {
  const claim =
    signer instanceof Uint8Array ? await signFaucetClaim(signer, chainId) : signer;
  return httpRequest<FaucetResponse>(faucetBaseUrl, '/faucet', {
    method: 'POST',
    json: {
      address: claim.address,
      expires: claim.expires,
      signature: claim.signature,
    },
  });
}
