/**
 * Cross-check between the challenge a credential carries and the terms the
 * route it was presented to actually asks for.
 *
 * Both verifiers read what to expect -- amount, currency, recipient -- from
 * `credential.challenge.request`. Over HTTP that is sound: mppx covers the
 * challenge with an HMAC the client cannot forge, and re-derives the route's own
 * challenge to compare before dispatching. So a client cannot present terms the
 * server never issued.
 *
 * Calling `verify()` directly has neither protection. Nothing checks the
 * challenge against the route, so a hand-built challenge asking for one drop is
 * honoured against a route charging one XRP. That path is used by tests, by
 * scripts, and by anyone embedding verification outside the middleware.
 *
 * mppx passes the route's request to `verify` and this compares the two. It is
 * defence in depth on the HTTP path and the only such check off it.
 */

import { verificationFailed } from '../errors.js'

/** Fields that decide what is owed. A disagreement on any of them is fatal. */
const PRICED_FIELDS = ['amount', 'currency', 'recipient'] as const

type PricedField = (typeof PRICED_FIELDS)[number]

/** Error code reported per field, so the caller sees which term disagreed. */
const CODE_FOR_FIELD: Record<PricedField, 'AMOUNT_MISMATCH' | 'SUBMISSION_FAILED'> = {
  amount: 'AMOUNT_MISMATCH',
  currency: 'SUBMISSION_FAILED',
  recipient: 'SUBMISSION_FAILED',
}

/** Currency is a string for XRP and an object for IOU and MPT. */
function describe(value: unknown): string {
  if (value === undefined) return 'none'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function equal(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  // Key order differs between a challenge that went over the wire and one built
  // in process, so compare structurally rather than by serialisation.
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeys)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  )
}

/**
 * Reject a credential whose challenge asks for different terms than the route.
 *
 * A route request is only present when the caller supplied one, so a bare
 * `verify({ credential })` is unaffected. Fields the route leaves unset are not
 * demands and are skipped.
 */
export function assertRouteTermsMatch(
  challengeRequest: Record<string, unknown> | undefined,
  routeRequest: Record<string, unknown> | undefined,
): void {
  if (!routeRequest || !challengeRequest) return

  for (const field of PRICED_FIELDS) {
    const expected = routeRequest[field]
    if (expected === undefined) continue
    const presented = challengeRequest[field]
    if (equal(expected, presented)) continue

    throw verificationFailed(
      CODE_FOR_FIELD[field],
      `Challenge ${field} ${describe(presented)} does not match the ${describe(expected)} this route requires`,
    )
  }
}
