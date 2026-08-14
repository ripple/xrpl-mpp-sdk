import { Challenge, Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { storeKeys } from '../../sdk/src/utils/keys.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const RECIPIENT = 'rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC'
const SECRET = 'w'.repeat(44)

/**
 * Every other suite builds credentials with `Credential.from`, which passes
 * fields straight through. A real HTTP flow serialises the credential into an
 * `Authorization: Payment` header and parses it back through mppx's strip-mode
 * schema, which silently drops anything the schema does not declare.
 *
 * That gap hid a class of defect: verification keyed off `challenge.createdAt`,
 * a field mppx never sets and its schema strips, so the check passed in every
 * hand-built test and never ran in production. These tests assert against the
 * post-round-trip shape so the same mistake cannot be made twice.
 */
function roundTrip(challenge: unknown, payload: unknown, source: string) {
  const credential = Credential.from({
    challenge: challenge as never,
    payload: payload as never,
    source,
  })
  return Credential.deserialize(Credential.serialize(credential))
}

describe('wire fidelity', () => {
  const challenge = Challenge.from({
    realm: 'test',
    method: 'xrpl',
    intent: 'charge',
    secretKey: SECRET,
    expires: new Date(Date.now() + 300_000).toISOString(),
    request: { amount: '1000000', currency: 'XRP', recipient: RECIPIENT },
  })

  it('mppx never populates createdAt, so nothing may depend on it', () => {
    // Guards the root cause directly: if a future mppx adds `createdAt`, this
    // fails and we can reconsider. Until then, no code may read it.
    expect((challenge as Record<string, unknown>).createdAt).toBeUndefined()
    expect(Object.keys(challenge)).not.toContain('createdAt')
  })

  it('keeps expires across the wire, since every bound is anchored on it', () => {
    const back = roundTrip(
      challenge,
      { type: 'hash', hash: 'AB'.repeat(32) },
      `did:pkh:xrpl:${NETWORK}:${RECIPIENT}`,
    )
    expect(back.challenge.expires).toBe(challenge.expires)
    expect(back.challenge.id).toBe(challenge.id)
  })

  it('drops fields absent from the mppx schema', () => {
    // Documents the mechanism. A field invented locally does not survive, so
    // verification must never read one.
    const back = roundTrip(
      { ...challenge, createdAt: new Date().toISOString(), invented: 'x' },
      { type: 'hash', hash: 'AB'.repeat(32) },
      `did:pkh:xrpl:${NETWORK}:${RECIPIENT}`,
    )
    expect((back.challenge as Record<string, unknown>).createdAt).toBeUndefined()
    expect((back.challenge as Record<string, unknown>).invented).toBeUndefined()
  })

  it('rejects an expired challenge that arrived over the wire', async () => {
    const expired = Challenge.from({
      realm: 'test',
      method: 'xrpl',
      intent: 'charge',
      secretKey: SECRET,
      expires: new Date(Date.now() - 1_000).toISOString(),
      request: { amount: '1000000', currency: 'XRP', recipient: RECIPIENT },
    })
    const back = roundTrip(
      expired,
      { type: 'hash', hash: 'AB'.repeat(32) },
      `did:pkh:xrpl:${NETWORK}:${Wallet.generate().address}`,
    )

    const method = serverCharge({
      recipient: RECIPIENT,
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
    })

    await expect(
      method.verify({ credential: back as never, request: expired.request as never }),
    ).rejects.toThrow(/Challenge expired/)
  })

  it('bounds replay retention for a credential that arrived over the wire', async () => {
    // The end-to-end property: a claim written for a real deserialized
    // credential carries an expiry derived from its surviving `expires`.
    const store = Store.memory()
    const back = roundTrip(
      challenge,
      { type: 'transaction', blob: 'DEADBEEF' },
      `did:pkh:xrpl:${NETWORK}:${Wallet.generate().address}`,
    )
    const method = serverCharge({
      recipient: RECIPIENT,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })

    // Fails on the undecodable blob, which is fine: what matters is that the
    // freshness check upstream of it accepted a wire-parsed challenge.
    await expect(
      method.verify({ credential: back as never, request: challenge.request as never }),
    ).rejects.not.toThrow(/Challenge expired/)

    // And nothing was claimed, since validation failed first.
    expect(await store.get(storeKeys(NETWORK).challenge(back.challenge.id))).toBeNull()
  })
})
