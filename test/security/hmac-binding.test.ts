import { Challenge, Credential } from 'mppx'
import { describe, expect, it } from 'vitest'

const SECRET = 'h'.repeat(44)
const RECIPIENT = 'rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC'

/**
 * Pins the HMAC challenge binding, which is the one security control this SDK
 * depends on but does not own.
 *
 * mppx derives `challenge.id` as an HMAC over the whole challenge, and the
 * entire charge flow rests on that: the expected amount, recipient and currency
 * are read back from the echoed challenge, and the payment binding is
 * `sha512half(challenge.id)`. If a future mppx weakened or changed the binding,
 * nothing in this repository would notice -- the peer range admits any 0.8.x,
 * and every other test supplies its own challenge rather than checking mppx's.
 *
 * These assertions are deliberately about mppx's behaviour, not ours. A failure
 * here means the dependency moved under us and the range needs re-testing, not
 * that our code regressed.
 */
function challengeWith(request: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Challenge.from({
    realm: 'test',
    method: 'xrpl',
    intent: 'charge',
    secretKey: SECRET,
    expires: '2030-01-01T00:00:00.000Z',
    request: request as never,
    ...extra,
  } as never)
}

const baseRequest = { amount: '1000000', currency: 'XRP', recipient: RECIPIENT }

describe('mppx HMAC challenge binding', () => {
  it('produces a stable id for identical inputs', () => {
    // Deterministic, so the binding is reproducible for verification.
    expect(challengeWith(baseRequest).id).toBe(challengeWith(baseRequest).id)
  })

  it('changes the id when the amount changes', () => {
    // The single most important property: a client cannot restate the price.
    expect(challengeWith(baseRequest).id).not.toBe(
      challengeWith({ ...baseRequest, amount: '1' }).id,
    )
  })

  it('changes the id when the recipient changes', () => {
    expect(challengeWith(baseRequest).id).not.toBe(
      challengeWith({ ...baseRequest, recipient: 'rNsjK2ucpiMJrjamrSvZDwkwX7kkdBZXJc' }).id,
    )
  })

  it('changes the id when the currency changes', () => {
    // Covers the IOU issuer-substitution defence, which relies on the expected
    // currency being authenticated rather than client-supplied.
    expect(challengeWith(baseRequest).id).not.toBe(
      challengeWith({
        ...baseRequest,
        currency: JSON.stringify({ currency: 'USD', issuer: RECIPIENT }),
      }).id,
    )
  })

  it('changes the id when expires changes', () => {
    // Every temporal bound the SDK applies is derived from `expires`, so it must
    // be covered by the HMAC or a client could extend its own window.
    expect(challengeWith(baseRequest).id).not.toBe(
      challengeWith(baseRequest, { expires: '2031-01-01T00:00:00.000Z' }).id,
    )
  })

  it('changes the id under a different secret', () => {
    const other = Challenge.from({
      realm: 'test',
      method: 'xrpl',
      intent: 'charge',
      secretKey: 'z'.repeat(44),
      expires: '2030-01-01T00:00:00.000Z',
      request: baseRequest as never,
    } as never)
    expect(challengeWith(baseRequest).id).not.toBe(other.id)
  })

  it('verifies a genuine challenge and rejects a tampered one', () => {
    const challenge = challengeWith(baseRequest)
    expect(Challenge.verify(challenge, { secretKey: SECRET })).toBe(true)

    // Restate the amount while keeping the issued id, which is exactly the
    // forgery the binding exists to stop.
    const tampered = { ...challenge, request: { ...baseRequest, amount: '1' } }
    expect(Challenge.verify(tampered as never, { secretKey: SECRET })).toBe(false)
  })

  it('rejects a challenge verified under the wrong secret', () => {
    const challenge = challengeWith(baseRequest)
    expect(Challenge.verify(challenge, { secretKey: 'z'.repeat(44) })).toBe(false)
  })

  it('survives the wire round-trip with the binding intact', () => {
    const challenge = challengeWith(baseRequest)
    const credential = Credential.from({
      challenge,
      payload: { type: 'hash', hash: 'AB'.repeat(32) } as never,
      source: `did:pkh:xrpl:testnet:${RECIPIENT}`,
    })
    const back = Credential.deserialize(Credential.serialize(credential))

    expect(Challenge.verify(back.challenge, { secretKey: SECRET })).toBe(true)
    expect(back.challenge.id).toBe(challenge.id)
  })

  it('still refuses to build a server without a secret', () => {
    // The binding cannot be disabled: Mppx.create throws rather than falling
    // back to an unauthenticated id.
    expect(() =>
      Challenge.from({ realm: 'test', method: 'xrpl', intent: 'charge' } as never),
    ).toThrow()
  })
})
