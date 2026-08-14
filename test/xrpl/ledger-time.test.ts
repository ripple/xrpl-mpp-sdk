/**
 * Pure unit tests for the ledger-time helpers.
 *
 * The helpers convert wall-clock challenge expiries into XRPL ledger
 * indices and back. They are exercised end-to-end through the client
 * (`charge-client.test.ts`) and server (`charge-metadata.test.ts`)
 * tests; this file focuses on the math and the boundary conditions.
 */

import { describe, expect, it } from 'vitest'
import {
  assertTxExpiresWithinChallenge,
  LEDGER_CLOSE_INTERVAL_MS,
  lastLedgerSequenceFromExpires,
  SERVER_SLACK_LEDGERS,
} from '../../sdk/src/utils/ledger-time.js'

const NOW = Date.parse('2026-05-07T10:00:00.000Z')
const inMs = (ms: number) => new Date(NOW + ms).toISOString()

describe('lastLedgerSequenceFromExpires', () => {
  it('returns current + ceil(msUntilExpiry / 4000) for typical 60s challenge', () => {
    const cap = lastLedgerSequenceFromExpires({
      currentLedgerIndex: 1_000,
      expiresIso: inMs(60_000),
      nowMs: NOW,
    })
    expect(cap).toBe(1_000 + Math.ceil(60_000 / LEDGER_CLOSE_INTERVAL_MS))
  })

  it('rounds up so a fractional remainder is a full ledger', () => {
    const cap = lastLedgerSequenceFromExpires({
      currentLedgerIndex: 50,
      expiresIso: inMs(5_000),
      nowMs: NOW,
    })
    expect(cap).toBe(50 + 2)
  })

  it('rejects expires already in the past', () => {
    expect(() =>
      lastLedgerSequenceFromExpires({
        currentLedgerIndex: 1_000,
        expiresIso: inMs(-1_000),
        nowMs: NOW,
      }),
    ).toThrow(/SUBMISSION_FAILED.*less than one ledger/)
  })

  it('rejects expires within one ledger interval (no room to land)', () => {
    expect(() =>
      lastLedgerSequenceFromExpires({
        currentLedgerIndex: 1_000,
        expiresIso: inMs(LEDGER_CLOSE_INTERVAL_MS),
        nowMs: NOW,
      }),
    ).toThrow(/SUBMISSION_FAILED/)
  })

  it('rejects unparseable expires', () => {
    expect(() =>
      lastLedgerSequenceFromExpires({
        currentLedgerIndex: 1_000,
        expiresIso: 'not-a-date',
        nowMs: NOW,
      }),
    ).toThrow(/INVALID_AMOUNT.*ISO-8601/)
  })
})

describe('assertTxExpiresWithinChallenge', () => {
  it('passes when txLastLedgerSequence is at the cap', () => {
    const cap = lastLedgerSequenceFromExpires({
      currentLedgerIndex: 1_000,
      expiresIso: inMs(60_000),
      nowMs: NOW,
    })
    expect(() =>
      assertTxExpiresWithinChallenge({
        txLastLedgerSequence: cap,
        currentLedgerIndex: 1_000,
        expiresIso: inMs(60_000),
        nowMs: NOW,
      }),
    ).not.toThrow()
  })

  it('passes when txLastLedgerSequence is within the slack window', () => {
    const cap = lastLedgerSequenceFromExpires({
      currentLedgerIndex: 1_000,
      expiresIso: inMs(60_000),
      nowMs: NOW,
    })
    expect(() =>
      assertTxExpiresWithinChallenge({
        txLastLedgerSequence: cap + SERVER_SLACK_LEDGERS,
        currentLedgerIndex: 1_000,
        expiresIso: inMs(60_000),
        nowMs: NOW,
      }),
    ).not.toThrow()
  })

  it('throws when txLastLedgerSequence exceeds cap + slack', () => {
    const cap = lastLedgerSequenceFromExpires({
      currentLedgerIndex: 1_000,
      expiresIso: inMs(60_000),
      nowMs: NOW,
    })
    expect(() =>
      assertTxExpiresWithinChallenge({
        txLastLedgerSequence: cap + SERVER_SLACK_LEDGERS + 1,
        currentLedgerIndex: 1_000,
        expiresIso: inMs(60_000),
        nowMs: NOW,
      }),
    ).toThrow(/SUBMISSION_FAILED.*LastLedgerSequence/)
  })

  it('no-ops when txLastLedgerSequence is undefined (hand-crafted tx without LLS)', () => {
    expect(() =>
      assertTxExpiresWithinChallenge({
        txLastLedgerSequence: undefined,
        currentLedgerIndex: 1_000,
        expiresIso: inMs(60_000),
        nowMs: NOW,
      }),
    ).not.toThrow()
  })

  it('rejects an intercepted blob whose LLS would let it land long past expires', () => {
    // Realistic attack: client signed a tx with LLS = current + 20
    // (~80s), but the challenge expires in 30s. The cap (8 ledgers)
    // plus slack (4) leaves 12 ledgers; LLS = 20 should fail.
    expect(() =>
      assertTxExpiresWithinChallenge({
        txLastLedgerSequence: 1_000 + 20,
        currentLedgerIndex: 1_000,
        expiresIso: inMs(30_000),
        nowMs: NOW,
      }),
    ).toThrow(/SUBMISSION_FAILED.*LastLedgerSequence/)
  })
})
