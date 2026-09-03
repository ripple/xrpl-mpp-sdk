/**
 * Replay-store key construction.
 *
 * Every key is namespaced by network. A Payment and a PaymentChannelCreate
 * carry no `NetworkID`, and one seed yields the same account and sequence space
 * everywhere, so the same account paying the same destination the same amount at
 * the same sequence produces an identical channelId and transaction hash on
 * testnet and on mainnet. Without the namespace, a store shared across networks
 * confuses state in both directions: a testnet payment marks a mainnet hash
 * spent, and testnet activity moves a mainnet channel's high-water mark.
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
 * Canonical form of a ledger hex identifier: uppercase.
 *
 * Hex is case-insensitive as a value and every layer downstream treats it so --
 * `verifyPaymentChannelClaim` hex-decodes the channel ID, and rippled resolves
 * `ledger_entry` and `tx` for either casing. A key must identify what those
 * layers identify, so case must not reach it: one identifier producing one key
 * per casing makes per-identifier state stop being single.
 *
 * Not for challenge identifiers -- those are base64url, where case carries
 * meaning and uppercasing would break the lookup and collide distinct ids.
 */
export function canonicalHex(value: string): string {
  return value.toUpperCase()
}

/**
 * Build the key set for a network.
 *
 * Each family name is a single segment (`channel-meta`, not `channel:meta`) so
 * no channel ID can steer one family's key onto another's. Under a shared
 * `channel:` prefix, `channel(':meta:x')` and `channelMeta('x')` would collide,
 * unreachable only because the schema constrains `channelId` to 64 hex
 * characters -- and a key layout should not rest on a constraint enforced
 * elsewhere.
 */
export function storeKeys(network: NetworkId): StoreKeys {
  const prefix = `xrpl:${network}`
  return {
    challenge: (challengeId) => `${prefix}:challenge:${challengeId}`,
    tx: (txHash) => `${prefix}:tx:${canonicalHex(txHash)}`,
    channel: (channelId) => `${prefix}:channel:${canonicalHex(channelId)}`,
    channelMeta: (channelId) => `${prefix}:channel-meta:${canonicalHex(channelId)}`,
    channelFinalized: (channelId) => `${prefix}:channel-finalized:${canonicalHex(channelId)}`,
    channelRedeemed: (channelId) => `${prefix}:channel-redeemed:${canonicalHex(channelId)}`,
  }
}
