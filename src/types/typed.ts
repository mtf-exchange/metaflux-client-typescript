// EIP-712 typed-action payload types (the structured wallet-signing path).
//
// These actions are signed as proper EIP-712 typed structs so a wallet
// (`eth_signTypedData_v4`) renders named fields instead of one opaque blob.
// Each interface carries exactly the action's signed fields; the envelope
// `nonce` is supplied at sign time (it is the same value bound into every typed
// struct). Decimal magnitudes ride as canonical decimal strings — the identical
// string is hashed and POSTed.

/// Chain tag carried as the first signed field (`metafluxChain`) of every typed
/// struct. Derived from the chain id at sign time; exported for callers that
/// want to construct the typed-data payload by hand.
export type MetafluxChainTag = 'Mainnet' | 'Testnet' | 'Devnet';

// ---- transfers (3) ----

/// `send_asset` — transfer an asset between dexes / accounts.
export interface SendAsset {
  /// Source dex id (`u32`).
  source_dex: number;
  /// Destination dex id (`u32`).
  destination_dex: number;
  /// Asset id (`u32`).
  asset: number;
  /// `0x`-hex 20-byte recipient address.
  destination: string;
  /// Amount as a canonical decimal string.
  amount: string;
  /// `true` moves the asset to the perp side.
  to_perp: boolean;
}

/// `usd_class_transfer` — move USD notional between the spot and perp classes.
export interface UsdClassTransfer {
  /// Notional amount as a canonical decimal string.
  ntl: string;
  /// `true` moves to the perp class, `false` to spot.
  to_perp: boolean;
}

/// `withdraw` — withdraw an asset to an external destination chain.
export interface Withdraw {
  /// Asset id (`u32`).
  asset: number;
  /// Amount as a canonical decimal string.
  amount: string;
  /// Destination EVM chain id (`u32`).
  destination_chain_id: number;
  /// `true` routes the withdrawal via CCTP.
  use_cctp: boolean;
}

// ---- account / staking / vault / metaliquidity (15) ----

/// `set_metaliquidity_set` — set a metaliquidity-set membership (validator
/// authorized). Distinct from the legacy `set_metaliquidity_whitelist` shape.
export interface SetMetaliquiditySet {
  /// `0x`-hex 20-byte account address.
  account: string;
  /// `true` adds to the set, `false` removes.
  allowed: boolean;
}
