import { describe, expect, it } from 'vitest'
import { assertRouteTermsMatch } from '../../sdk/src/utils/route.js'

/**
 * Both verifiers read the terms they enforce from the challenge the credential
 * carries. Over HTTP mppx guarantees that challenge is one this server issued
 * for this route -- the id is an HMAC, and the route's own challenge is
 * re-derived and compared before dispatch.
 *
 * Called directly, `verify()` has neither guarantee, and a hand-built challenge
 * asking for one drop was honoured against a route charging one XRP. The error
 * showcase demonstrated exactly that and reported "Expected error but
 * succeeded".
 */

const RECIPIENT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
const OTHER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'

const route = {
  amount: '1000000',
  currency: 'XRP',
  recipient: RECIPIENT,
}

describe('route terms', () => {
  it('accepts a challenge asking for exactly the route terms', () => {
    expect(() => assertRouteTermsMatch({ ...route }, route)).not.toThrow()
  })

  it('rejects an underpriced challenge', () => {
    expect(() => assertRouteTermsMatch({ ...route, amount: '1' }, route)).toThrow(
      /Challenge amount 1 does not match the 1000000 this route requires/,
    )
  })

  it('rejects a redirected recipient', () => {
    expect(() => assertRouteTermsMatch({ ...route, recipient: OTHER }, route)).toThrow(
      /does not match the .* this route requires/,
    )
  })

  it('rejects a substituted currency', () => {
    expect(() =>
      assertRouteTermsMatch(
        { ...route, currency: { currency: 'USD', issuer: OTHER } },
        { ...route, currency: 'XRP' },
      ),
    ).toThrow(/Challenge currency/)
  })

  it('rejects a missing term rather than treating it as agreement', () => {
    expect(() => assertRouteTermsMatch({ currency: 'XRP', recipient: RECIPIENT }, route)).toThrow(
      /Challenge amount none/,
    )
  })

  it('compares issued currencies structurally, not by key order', () => {
    const usd = { currency: 'USD', issuer: OTHER }
    const reordered = { issuer: OTHER, currency: 'USD' }
    expect(() =>
      assertRouteTermsMatch({ ...route, currency: reordered }, { ...route, currency: usd }),
    ).not.toThrow()
  })

  it('rejects an issued currency from a different issuer', () => {
    expect(() =>
      assertRouteTermsMatch(
        { ...route, currency: { currency: 'USD', issuer: RECIPIENT } },
        { ...route, currency: { currency: 'USD', issuer: OTHER } },
      ),
    ).toThrow(/Challenge currency/)
  })

  it('leaves a bare verify() untouched', () => {
    // No route request means no demand to compare against, which is what a
    // direct verify({ credential }) passes.
    expect(() => assertRouteTermsMatch({ amount: '1' }, undefined)).not.toThrow()
  })

  it('ignores terms the route does not set', () => {
    // A route that names only a recipient is not asserting a price.
    expect(() =>
      assertRouteTermsMatch({ ...route, amount: '5' }, { recipient: RECIPIENT }),
    ).not.toThrow()
  })

  it('does not treat a numeric amount as equal to its string form', () => {
    // XRPL amounts are strings throughout; a loose compare here would let
    // 1000000 satisfy a route expecting drops as a string and vice versa.
    expect(() => assertRouteTermsMatch({ ...route, amount: 1_000_000 as never }, route)).toThrow(
      /Challenge amount/,
    )
  })
})
