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
/**
 * Canonical form of a ledger hex identifier: uppercase.
 *
 * Hex is case-insensitive as a value, and everything downstream treats it that
 * way. `verifyPaymentChannelClaim` hex-decodes the channel ID, so a claim signed
 * over an uppercase ID verifies against the lowercase one. rippled resolves
 * `ledger_entry` and `tx` lookups for either casing. Only the store key was
 * case-sensitive, and only because it was built by string interpolation.
 *
 * A store key must therefore identify what those layers identify. Built by
 * interpolation it did not: one identifier produced one key per casing, so
 * per-identifier state -- a channel's high-water mark, the single-use marker for
 * a push-mode transaction hash, a closed-channel tombstone -- was not single.
 *
 * Canonicalising here rather than at each call site means a new key family
 * cannot reintroduce it by forgetting.
 *
 * Not applied to challenge identifiers: those are base64url from mppx, where
 * case carries meaning and uppercasing would both break the lookup and collide
 * distinct challenges.
 */
export function canonicalHex(value: string): string {
  return value.toUpperCase()
}

export function storeKeys(network: NetworkId): StoreKeys {
  const prefix = `xrpl:${network}`
  return {
    // Base64url from mppx: case carries meaning, so it is passed through.
    challenge: (challengeId) => `${prefix}:challenge:${challengeId}`,
    tx: (txHash) => `${prefix}:tx:${canonicalHex(txHash)}`,
    channel: (channelId) => `${prefix}:channel:${canonicalHex(channelId)}`,
    channelMeta: (channelId) => `${prefix}:channel-meta:${canonicalHex(channelId)}`,
    channelFinalized: (channelId) => `${prefix}:channel-finalized:${canonicalHex(channelId)}`,
    channelRedeemed: (channelId) => `${prefix}:channel-redeemed:${canonicalHex(channelId)}`,
  }
}
