// MTF-native SD-1 spot-deployer action payload types (MIP-1).
//
// The permissionless spot lane: register a token, register a pair against it,
// set the pair's fees and min notional, open or close the pair, stage the
// genesis holder rows, then seal the supply. All six are SENDER-AUTHORIZED —
// the recovered signer IS the deployer, so none of them takes an `owner`.
//
// Naming deviates from other venues on purpose: `asset` not `token`, `pair` not
// `spot`, named `base` / `quote` instead of a two-int array, and `max_deploy_fee`
// not `max_gas` (this one is a whole-USDC Dutch accept price, not gas).
//
// PAY AT REGISTER. `spot_register_token` and `spot_register_pair` each take the
// Dutch-clock ask at the moment they commit. `max_deploy_fee` is the highest
// price the signer accepts: the node refuses the call when the clock asks more.
// On the default USDC lane the fee comes out of FREE collateral, so a fully
// committed account cannot deploy. A granted deploy credit skips the payment.
//
// DECIMAL FIELDS ARE VERBATIM. `max_deploy_fee`, `max_supply` and every element
// of `amounts` are hashed as the exact text sent, then parsed. `"1.0"` and
// `"1.00"` are the same number and two different signatures. Pass the string
// through untouched; never round-trip it through `Number`.

/// `spot_register_token` — register a fresh spot token and pay the Dutch-clock
/// ask. The signer becomes the token's deployer.
///
/// A deployer cannot self-declare a token canonical and cannot bind its own EVM
/// contract: neither field is on this wire. Both are governance moves.
export interface SpotRegisterToken {
  /// Token symbol.
  symbol: string;
  /// Display / size precision (`u8`). The node caps it at its own
  /// `MAX_SZ_DECIMALS`.
  sz_decimals: number;
  /// Native (ERC-20 style) token decimals (`u8`, `1`–`18`). The node refuses
  /// anything above 18.
  wei_decimals: number;
  /// Highest Dutch accept price the signer takes, in whole USDC, as a decimal
  /// string. The node refuses the call when the clock asks more.
  max_deploy_fee: string;
}

/// `spot_register_pair` — register a `(base, quote)` trading pair and pay the
/// Dutch-clock ask.
export interface SpotRegisterPair {
  /// Base token id (`u32`).
  base: number;
  /// Quote token id (`u32`). USDC today.
  quote: number;
  /// Pair name.
  name: string;
  /// Highest Dutch accept price the signer takes, in whole USDC, as a decimal
  /// string.
  max_deploy_fee: string;
}

/// `spot_set_pair_params` — set the pair's fee tier and min notional in one
/// intent.
///
/// Both fee legs are DECI-bps and the node refuses either at `1000` or above:
/// the packing it decodes gives each leg three decimal digits. So `45` is
/// 4.5 bps, not 45 bps.
export interface SpotSetPairParams {
  /// Spot pair id (`u32`).
  pair: number;
  /// Taker fee in deci-bps (`u32`, `< 1000`).
  taker_fee_dbps: number;
  /// Maker fee in deci-bps (`u32`, `< 1000`).
  maker_fee_dbps: number;
  /// Min order notional in USDC cents (`u64`).
  min_notional_cents: number;
}

/// `spot_set_pair_active` — open (`true`) or close (`false`) the pair to new
/// orders.
export interface SpotSetPairActive {
  /// Spot pair id (`u32`).
  pair: number;
  /// `true` opens the pair, `false` closes it.
  active: boolean;
}

/// `spot_seed_holders` — stage genesis holder rows for a registered token.
/// Repeatable: call it once per batch of rows, then seal with
/// [`SpotFinalizeSupply`].
///
/// `holders` and `amounts` are PARALLEL and the node refuses a length mismatch,
/// an empty call, and a batch above its per-call row cap. Both arrays are inside
/// the signed digest, in order, so no relay can re-target, re-size or re-order a
/// staged row under a replayed signature.
///
/// A holder can be staged ONE time only, and an amount finer than the token's
/// `wei_decimals` is refused. Both rules hold the mint exact: the staged total
/// must equal the sum of the credited balances, with no rounding step.
export interface SpotSeedHolders {
  /// The spot token being staged (`u32`).
  asset: number;
  /// Holder addresses (`0x`-hex), parallel with `amounts`.
  holders: string[];
  /// Amounts in WHOLE units, as verbatim decimal strings, parallel with
  /// `holders`. Never wei — a wei amount mints 10^18 times too much and the
  /// `max_supply` checksum still agrees, so the error is silent.
  amounts: string[];
}

/// `spot_finalize_supply` — check the staged rows, then mint once.
///
/// `max_supply` is an integrity check on the seed SEQUENCE, not a setting: it
/// proves every [`SpotSeedHolders`] call landed. The node refuses the seal when
/// the staged rows do not sum to it.
export interface SpotFinalizeSupply {
  /// The spot token being sealed (`u32`).
  asset: number;
  /// The sum over every staged row, in WHOLE units, as a verbatim decimal
  /// string.
  max_supply: string;
}
