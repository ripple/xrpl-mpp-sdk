/** XRPL network identifiers, RPC URLs, faucet endpoints, explorer URLs, and well-known assets. */

export const XRPL_NETWORK_IDS = {
  mainnet: 0,
  testnet: 1,
  devnet: 2,
} as const

export type NetworkId = keyof typeof XRPL_NETWORK_IDS

export const XRPL_RPC_URLS: Record<NetworkId, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
  devnet: 'wss://s.devnet.rippletest.net:51233',
}

export const XRPL_FAUCET_URLS: Record<NetworkId, string> = {
  mainnet: '',
  testnet: 'https://faucet.altnet.rippletest.net/accounts',
  devnet: 'https://faucet.devnet.rippletest.net/accounts',
}

export const XRPL_EXPLORER_URLS: Record<NetworkId, string> = {
  mainnet: 'https://xrpl.org/transactions/',
  testnet: 'https://testnet.xrpl.org/transactions/',
  devnet: 'https://devnet.xrpl.org/transactions/',
}

/** XRP native currency identifier. */
export const XRP = 'XRP' as const

/**
 * RLUSD on mainnet. Official issuer from
 * https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
 *
 * `currency` is the **hex-encoded** form because the human-readable code
 * `RLUSD` is 5 characters, and XRPL's native IOU codes must be either 3
 * ASCII characters or a 40-character hex string. Wallets and explorers
 * decode it back to `RLUSD` for display.
 */
export const RLUSD_MAINNET = {
  currency: '524C555344000000000000000000000000000000',
  issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
} as const

/**
 * RLUSD on testnet. Official issuer from
 * https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
 *
 * `currency` is the **hex-encoded** form because the human-readable code
 * `RLUSD` is 5 characters, and XRPL's native IOU codes must be either 3
 * ASCII characters or a 40-character hex string. Wallets and explorers
 * decode it back to `RLUSD` for display.
 */
export const RLUSD_TESTNET = {
  currency: '524C555344000000000000000000000000000000',
  issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
} as const

/** XRP has 6 decimal places (drops). */
export const XRP_DECIMALS = 6

/** Default transaction timeout in seconds. */
export const DEFAULT_TIMEOUT = 60

/**
 * On-chain attribution tag applied by default as the `SourceTag` on every
 * transaction the SDK originates (charge, channel, escrow, trustline, MPT).
 * Lets SDK-originated activity be identified on-chain by filtering
 * `SourceTag == 593184257`.
 *
 * It is a **default**: any explicit `sourceTag` (e.g. one a charge challenge
 * requires, or one passed to `createEscrow`) takes precedence, since `SourceTag`
 * is a single 32-bit field and cannot hold both values.
 */
export const MPP_SOURCE_TAG = 593184257

/**
 * Mainnet base reserve in drops (1 XRP after the ReducedReserve amendment).
 * Static fallback only -- the SDK's preflight reads live values via server_state.
 */
export const BASE_RESERVE_DROPS = '1000000'

/**
 * Mainnet per-owner-object reserve in drops (0.2 XRP after ReducedReserve).
 * Static fallback only -- the SDK's preflight reads live values via server_state.
 */
export const OWNER_RESERVE_DROPS = '200000'
