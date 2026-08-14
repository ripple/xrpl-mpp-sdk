/**
 * Replay-store key construction.
 *
 * Every key is namespaced by network. Channel IDs and transaction hashes derive
 * purely from transaction content, and mainnet, testnet and devnet carry no
 * `NetworkID` field on a Payment or a PaymentChannelCreate. A wallet built from
 * one seed therefore has the same account and the same sequence space on every
 * network, so the same account paying the same destination the same amount at
 * the same sequence produces an **identical channelId and an identical
 * transaction hash** on testnet and on mainnet.
 *
 * Without the network segment, one store shared across networks gives
 * cross-network state confusion in both directions: a testnet payment can mark
 * a mainnet transaction hash as already spent, and testnet activity can move a
 * mainnet channel's high-water mark.
 *
 * Keys are built here rather than interpolated at each call site so the layout
 * is auditable in one place, and so a caller cannot accidentally omit the
 * namespace.
 */

import type { NetworkId } from '../constants.js'

/** Key builders for one network. */
export type StoreKeys = {
  /** Single-use marker for a 402 challenge. */
  challenge: (challengeId: string) => string
  /** Single-use marker for a settled transaction hash. */
  tx: (txHash: string) => string
  /** Cumulative high-water mark for a channel. */
  channel: (channelId: string) => string
  /** Cached PayChannel ledger metadata. */
  channelMeta: (channelId: string) => string
  /** Tombstone: channel closed, expired, or not found on the ledger. */
  channelFinalized: (channelId: string) => string
  /** Record of the cumulative already redeemed on-chain. */
  channelRedeemed: (channelId: string) => string
}

/**
 * Build the key set for a network.
 *
 * Each family name is a single segment (`channel-meta`, not `channel:meta`), so
 * no channel ID can steer one family's key onto another's. Nesting them under a
 * shared `channel:` prefix would make `channel(':meta:x')` and
 * `channelMeta('x')` the same key, which is only unreachable because the schema
 * constrains `channelId` to 64 hex characters -- and a key layout should not
 * depend on a constraint enforced somewhere else.
 */
export function storeKeys(network: NetworkId): StoreKeys {
  const prefix = `xrpl:${network}`
  return {
    challenge: (challengeId) => `${prefix}:challenge:${challengeId}`,
    tx: (txHash) => `${prefix}:tx:${txHash}`,
    channel: (channelId) => `${prefix}:channel:${channelId}`,
    channelMeta: (channelId) => `${prefix}:channel-meta:${channelId}`,
    channelFinalized: (channelId) => `${prefix}:channel-finalized:${channelId}`,
    channelRedeemed: (channelId) => `${prefix}:channel-redeemed:${channelId}`,
  }
}
