# Changelog

All notable changes to the TypeScript SDK are documented here.

## [0.7.17] Backend Compatibility

### Fee Precision

The `/info` fee schedule response now supports finer granularity for fee rates. Fee fields (`maker_bps`, `taker_bps`, `builder_rebate_bps`, `referrer_share_bps`) are decimal basis-point strings with optional fractional digits — for example, `"5.0"` (5 bps) or `"0.5"` (half a bps). The SDK already types these as `string`, so clients parsing them as decimal numbers are unaffected; clients that previously assumed integer basis points must update to handle the fractional component.

### EVM Transaction Signature Verification

The network now verifies EVM transaction signatures at the consensus layer. EVM transactions must be submitted as standard Ethereum raw transactions via `eth_sendRawTransaction` with RLP-encoded signed transaction bytes. The network validates that the signature recovers to the declared sender, preventing Byzantine proposers from forging transaction senders. Standard EVM clients and wallets that already send properly-signed raw transactions are unaffected.
