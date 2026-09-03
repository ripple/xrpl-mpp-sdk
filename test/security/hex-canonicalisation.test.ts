import { Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { canonicalHex, storeKeys } from '../../sdk/src/utils/keys.js'
import { advanceHighWater, claimKey } from '../../sdk/src/utils/store.js'

/**
 * Hex is case-insensitive as a value, and every layer below the store already
 * treats it that way: `verifyPaymentChannelClaim` hex-decodes the channel ID, so
 * a claim signed over `A1B2...` verifies against `a1b2...`, and rippled resolves
 * either casing for `ledger_entry` and `tx`. A store key built by interpolating
 * the identifier was the one case-sensitive step in that chain.
 *
 * A key has to identify the same thing the layers beneath it identify. When it
 * does not, one identifier maps to several keys, and per-identifier state -- a
 * high-water mark, a single-use marker, a tombstone -- stops being single.
 */

const ID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2'
const LOWER = ID.toLowerCase()
const MIXED = `${ID.slice(0, 32)}${LOWER.slice(32)}`

describe('hex identifiers are canonical in store keys', () => {
  const keys = storeKeys('testnet')

  it('maps every casing of a channel ID to one key', () => {
    for (const variant of [LOWER, MIXED]) {
      expect(keys.channel(variant), variant).toBe(keys.channel(ID))
    }
  })

  it('does the same for the tombstone and metadata families', () => {
    expect(keys.channelFinalized(LOWER)).toBe(keys.channelFinalized(ID))
    expect(keys.channelRedeemed(LOWER)).toBe(keys.channelRedeemed(ID))
    expect(keys.channelMeta(LOWER)).toBe(keys.channelMeta(ID))
  })

  it('maps every casing of a transaction hash to one key', () => {
    // Push mode takes the hash from the client, so this one is caller-supplied.
    expect(keys.tx(LOWER)).toBe(keys.tx(ID))
  })

  it('leaves challenge identifiers alone', () => {
    // mppx issues base64url, where case is meaning: uppercasing would break the
    // lookup and could collide two distinct challenges.
    const id = 'J9x7nL-XldbW6ilaqGSWNWkxrYDMkc72BymcYTKZzsA'
    expect(keys.challenge(id)).toContain(id)
    expect(keys.challenge(id)).not.toBe(keys.challenge(id.toUpperCase()))
  })

  it('canonicalHex is idempotent', () => {
    expect(canonicalHex(canonicalHex(LOWER))).toBe(canonicalHex(LOWER))
  })
})

describe('the replay the casing gap allowed', () => {
  it('refuses the same cumulative under a different casing', async () => {
    const store = Store.memory()
    const keys = storeKeys('testnet')
    const claim = { cumulative: 100_000n, requested: 0n, signature: 'DEAD', timestamp: 1 }

    const first = await advanceHighWater(store, keys.channel(ID), claim)
    expect(first.status).toBe('advanced')

    // The identical voucher, channel ID lowercased. Its signature still verifies
    // and the ledger still resolves it, so the store is the only thing standing
    // between this and free service.
    const second = await advanceHighWater(store, keys.channel(LOWER), claim)
    expect(second.status).toBe('replay')

    const third = await advanceHighWater(store, keys.channel(MIXED), claim)
    expect(third.status).toBe('replay')
  })

  it('refuses a settled transaction hash under a different casing', async () => {
    const store = Store.memory()
    const keys = storeKeys('testnet')

    expect(await claimKey(store, keys.tx(ID), { at: 1 })).toBe(true)
    expect(await claimKey(store, keys.tx(LOWER), { at: 1 })).toBe(false)
    expect(await claimKey(store, keys.tx(MIXED), { at: 1 })).toBe(false)
  })
})
