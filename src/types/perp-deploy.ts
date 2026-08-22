// MTF-native MIP-3 perp-deployer action payload types.
//
// The permissionless perp lane: register a market, bind its oracle subset, set
// leverage / fees / rebate / min size, delegate authority, then open or close
// the market. All nine are SENDER-AUTHORIZED — the recovered signer IS the
// deployer, so none of them takes an `owner`. After registration the market's
// deployer and its sub-deployers are the only accounts the handler accepts.
//
// `mip3_set_oracle_px` is the TENTH deployer action and the only repeating one:
// a market may run its own index feed, and the deployer then pushes every
// price. It is sender-authorized in the same way, and it rides a SEPARATE fork
// feature from the nine — see `Mip3SetOraclePx`.
//
// NOT LIVE YET. The nine wire tags landed in the node (commit e04489363) but
// that binary is not released. The live chain refuses all nine today, the same
// way it refuses an action that does not exist. They start working at the
// freeze-swap height of the release that carries them.
//
// NONE of them carries a `bid`. The legacy gas-auction lane is dead and the
// handler rejects a non-zero bid, so the field is off this wire entirely.
//
// ASSET IDS. A MIP-3 market gets an id at or above 1000; the ids below that are
// the chain's own perps. `perp_register_asset` allocates the id and every other
// action here takes it back as `asset`.
//
// TWO GOVERNANCE LIMITS BIND THIS LANE, and `0` means UNCAPPED for both — never
// blocked. `max_deploys_per_epoch` rate-limits new-asset registration across
// this lane and both spot lanes together. `fee_ceiling_bps` bounds the taker and
// maker legs. The off-switch is separate: governance sets `mip3_enabled`.

/// `perp_register_asset` — allocate a fresh MIP-3 perp market. The signer
/// becomes the market's deployer.
///
/// A deployer cannot pick the asset id: the node allocates it. Read the id back
/// before calling any of the other eight actions.
export interface PerpRegisterAsset {
  /// Market symbol, 1 to 32 bytes (e.g. `"WIF"`). The node refuses an empty
  /// symbol and one above the cap.
  symbol: string;
  /// Token decimals (`u8`, at most 18).
  ///
  /// **`0` is not "zero decimals".** The handler reads `0` as its default of 8.
  /// Send the value you mean; there is no way to ask for a decimal-free market.
  decimals: number;
}

/// `perp_set_oracle` — bind the market's enabled oracle-source subset.
export interface PerpSetOracle {
  /// Target market asset id (`u32`).
  asset: number;
  /// Bitmask of enabled oracle sources (`u16`). The handler bounds it to the
  /// ten defined sources, so a bit above that set is refused.
  oracle_source_mask: number;
}

/// `perp_set_leverage` — set the market's max leverage.
export interface PerpSetLeverage {
  /// Target market asset id (`u32`).
  asset: number;
  /// Max leverage (`u8`). The handler bounds it to `1`–`50`.
  max_leverage: number;
}

/// `perp_set_fee_tier` — set the three fee legs in one intent.
///
/// The signer states each leg SEPARATELY and signs the legs it means; the node
/// packs them into the single encoded value its handler decodes. No client has
/// to reproduce that packing.
///
/// **Every leg must stay below `1000`.** The packing gives each leg three
/// decimal digits, so a leg at `1000` or above carries into its neighbour and
/// the digest stops binding what the handler applies. The node refuses it.
///
/// **The two fee planes differ. Read the field names.** `taker_fee_dbps` and
/// `maker_fee_dbps` are DECI-bps (tenths of a bp), so `45` is 4.5 bps.
/// `deployer_fee_bps` is WHOLE bps, so `6` is 6 bps.
///
/// **A governance ceiling also binds the taker and maker legs**, and it is
/// stated in WHOLE bps while those two legs are DECI-bps. A ceiling of `20` bps
/// therefore admits `taker_fee_dbps` up to `200`. A ceiling of `0` is UNCAPPED.
/// The deployer leg sits outside this ceiling. A separate per-market
/// `max_taker_fee_dbps` always binds; the tighter of the two wins.
export interface PerpSetFeeTier {
  /// Target market asset id (`u32`).
  asset: number;
  /// Taker fee in DECI-bps (`u32`, `< 1000`).
  taker_fee_dbps: number;
  /// Maker fee in DECI-bps (`u32`, `< 1000`).
  maker_fee_dbps: number;
  /// Deployer cut in WHOLE bps (`u32`, `< 1000`).
  deployer_fee_bps: number;
}

/// `perp_set_maker_rebate` — set the market's maker rebate.
export interface PerpSetMakerRebate {
  /// Target market asset id (`u32`).
  asset: number;
  /// Rebate in WHOLE bps (`u16`). The handler bounds it to `0`–`2`.
  rebate_bps: number;
}

/// `perp_set_min_size` — set the market's min order size.
export interface PerpSetMinSize {
  /// Target market asset id (`u32`).
  asset: number;
  /// Min order size in the market's SIZE plane (`u64`), not a notional and not
  /// a decimal string.
  min_order_size: number;
}

/// `perp_activate_market` — open the market to trading.
export interface PerpActivateMarket {
  /// Target market asset id (`u32`).
  asset: number;
}

/// `perp_deactivate_market` — close the market to NEW orders.
export interface PerpDeactivateMarket {
  /// Target market asset id (`u32`).
  asset: number;
}

/// `perp_set_sub_deployers` — add or remove ONE delegated deployer.
///
/// A sub-deployer then signs the other eight actions for this market as if it
/// were the deployer. Call it once per delegate; the action carries a single
/// address, not a set.
///
/// **Both `sub_deployer` and `add` sit inside the signed digest.** A relay
/// therefore cannot re-target the delegate, and cannot flip a removal into a
/// grant, under a replayed signature.
export interface PerpSetSubDeployers {
  /// Target market asset id (`u32`).
  asset: number;
  /// The delegate address (`0x`-hex). The node refuses an unparsable address at
  /// admission.
  sub_deployer: string;
  /// `true` adds the delegate, `false` removes it.
  add: boolean;
}

/// `mip3_set_oracle_px` — push the market's index px from its deployer oracle.
///
/// Gated by its own fork feature, `mip3_deployer_oracle`, which is ACTIVE FROM
/// GENESIS on a fresh chain. Only a legacy or unknown network keeps it dormant
/// and answers `mip3_deployer_oracle feature not active` until a two-thirds
/// stake vote arms it. Probe your target network; do not assume.
///
/// Only the market's deployer or a registered sub-deployer may sign a push. No
/// relay and no system sender can inject one.
///
/// The feed is load-bearing, not advisory. Once the feature is armed:
///
/// - The FIRST push force-migrates every existing cross leg on the market to
///   strict-isolated margin, and every later leg opens strict-isolated.
/// - A feed that goes stale flips the market reduce-only: opens are refused and
///   closes always pass. Push faster than the staleness window.
export interface Mip3SetOraclePx {
  /// Target market asset id (`u32`).
  asset: number;
  /// The pushed index px, as a WHOLE-USDC decimal string — never the 1e8 book
  /// plane, and never a JSON number.
  ///
  /// The node hashes this string VERBATIM, so the signature covers the
  /// SPELLING and not the value: `"1250.5"` and `"1250.50"` are one price and
  /// two digests. Build the string once, then sign and send the same bytes.
  px: string;
}
