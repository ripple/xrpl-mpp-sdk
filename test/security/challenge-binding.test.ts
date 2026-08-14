import { describe, expect, it } from 'vitest'
import { type PaymentExpectations, validatePaymentFields } from '../../sdk/src/server/Charge.js'
import { challengeInvoiceId, isInvoiceIdShape } from '../../sdk/src/utils/binding.js'
import {
  assertTxNotOlderThanChallenge,
  LEDGER_CLOSE_INTERVAL_MS,
} from '../../sdk/src/utils/ledger-time.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHALLENGE_ID = 'challenge-for-binding-tests'
const BOUND = challengeInvoiceId(CHALLENGE_ID)

function scenario(overrides: {
  txInvoiceId?: string | undefined
  invoiceIdRequired: boolean
  expectedInvoiceId?: string | undefined
}) {
  const payer = Wallet.generate()
  const recipient = Wallet.generate()

  const tx = {
    TransactionType: 'Payment',
    Account: payer.address,
    Destination: recipient.address,
    Amount: '1000000',
    SourceTag: 0,
    ...(overrides.txInvoiceId !== undefined ? { InvoiceID: overrides.txInvoiceId } : {}),
  }

  const expected: PaymentExpectations = {
    amount: '1000000',
    recipient: recipient.address,
    currency: 'XRP',
    sender: payer.address,
    invoiceId: 'expectedInvoiceId' in overrides ? overrides.expectedInvoiceId : BOUND,
    invoiceIdRequired: overrides.invoiceIdRequired,
  }

  return { tx, expected }
}

describe('challenge binding', () => {
  describe('server-side enforcement', () => {
    it('accepts a payment carrying the derived binding', () => {
      const { tx, expected } = scenario({ txInvoiceId: BOUND, invoiceIdRequired: true })
      expect(() => validatePaymentFields(tx, expected)).not.toThrow()
    })

    it('rejects a payment bound to a different challenge', () => {
      const { tx, expected } = scenario({
        txInvoiceId: challengeInvoiceId('some-other-challenge'),
        invoiceIdRequired: true,
      })
      expect(() => validatePaymentFields(tx, expected)).toThrow('InvoiceID mismatch')
    })

    it('rejects an unbound payment in push mode', () => {
      // No InvoiceID at all: the payment could have been made for anything.
      const { tx, expected } = scenario({ invoiceIdRequired: true })
      expect(() => validatePaymentFields(tx, expected)).toThrow('not bound to this challenge')
    })

    it('names the escape hatch in the unbound-push error', () => {
      const { tx, expected } = scenario({ invoiceIdRequired: true })
      expect(() => validatePaymentFields(tx, expected)).toThrow('allowUnboundPushMode')
    })

    it('accepts an unbound payment in pull mode', () => {
      // Pull mode is protected by account-sequence consumption, so a missing
      // binding is tolerated for clients that predate the field.
      const { tx, expected } = scenario({ invoiceIdRequired: false })
      expect(() => validatePaymentFields(tx, expected)).not.toThrow()
    })

    it('still rejects a wrong binding in pull mode when one is present', () => {
      const { tx, expected } = scenario({
        txInvoiceId: challengeInvoiceId('other'),
        invoiceIdRequired: false,
      })
      expect(() => validatePaymentFields(tx, expected)).toThrow('InvoiceID mismatch')
    })

    it('accepts an unbound push payment when explicitly acknowledged', () => {
      // allowUnboundPushMode: true resolves to invoiceIdRequired: false.
      const { tx, expected } = scenario({ invoiceIdRequired: false })
      expect(() => validatePaymentFields(tx, expected)).not.toThrow()
    })

    it('rejects an absent InvoiceID when the operator demanded one', () => {
      // Regression: an operator-supplied invoiceId is a demand, not a default.
      // A `tx.InvoiceID !== undefined` guard once let a payment carrying no
      // InvoiceID satisfy a challenge that asked for a specific one, so the
      // order was fulfilled against an unattributable payment.
      const merchantInvoice = 'F'.repeat(64)
      const { tx, expected } = scenario({
        invoiceIdRequired: true,
        expectedInvoiceId: merchantInvoice,
      })
      expect(() => validatePaymentFields(tx, expected)).toThrow('not bound to this challenge')
    })

    it('rejects a wrong InvoiceID when the operator demanded one', () => {
      const merchantInvoice = 'F'.repeat(64)
      const { tx, expected } = scenario({
        txInvoiceId: 'A'.repeat(64),
        invoiceIdRequired: true,
        expectedInvoiceId: merchantInvoice,
      })
      expect(() => validatePaymentFields(tx, expected)).toThrow('InvoiceID mismatch')
    })

    it('rejects a non-Payment transaction', () => {
      // Push mode presents a hash, so without this an EscrowCreate with the
      // right Destination and Amount passed as proof while delivering nothing.
      const { tx, expected } = scenario({ txInvoiceId: BOUND, invoiceIdRequired: true })
      for (const type of ['EscrowCreate', 'PaymentChannelCreate', 'OfferCreate', undefined]) {
        expect(() => validatePaymentFields({ ...tx, TransactionType: type }, expected)).toThrow(
          'Expected a Payment transaction',
        )
      }
    })

    it('honours an operator-supplied invoiceId over the derived binding', () => {
      const merchantInvoice = 'F'.repeat(64)
      const { tx, expected } = scenario({
        txInvoiceId: merchantInvoice,
        invoiceIdRequired: true,
        expectedInvoiceId: merchantInvoice,
      })
      expect(() => validatePaymentFields(tx, expected)).not.toThrow()
    })
  })

  describe('challengeInvoiceId', () => {
    it('produces a valid InvoiceID shape', () => {
      const id = challengeInvoiceId('challenge-abc')
      expect(id).toHaveLength(64)
      expect(isInvoiceIdShape(id)).toBe(true)
      expect(id).toBe(id.toUpperCase())
    })

    it('is deterministic for the same challenge id', () => {
      expect(challengeInvoiceId('same')).toBe(challengeInvoiceId('same'))
    })

    it('differs for different challenge ids', () => {
      expect(challengeInvoiceId('one')).not.toBe(challengeInvoiceId('two'))
    })

    it('differs for challenge ids that share a prefix', () => {
      // The HMAC-bound challenge ids mppx issues are base64url and can share
      // leading characters; the binding must depend on the whole value.
      expect(challengeInvoiceId('abcdef')).not.toBe(challengeInvoiceId('abcdeg'))
    })

    it('rejects non-hex and wrong-length values as InvoiceID shapes', () => {
      expect(isInvoiceIdShape('Z'.repeat(64))).toBe(false)
      expect(isInvoiceIdShape('A'.repeat(63))).toBe(false)
      expect(isInvoiceIdShape('A'.repeat(65))).toBe(false)
      expect(isInvoiceIdShape(undefined)).toBe(false)
      expect(isInvoiceIdShape(12345)).toBe(false)
    })
  })

  describe('assertTxNotOlderThanChallenge', () => {
    const nowMs = Date.parse('2026-01-01T00:05:00.000Z')
    // Challenge issued at 00:00, expiring at 00:05 with a 5-minute lifetime.
    const expiresIso = '2026-01-01T00:05:00.000Z'
    const maxChallengeLifetime = 300_000

    it('accepts a transaction validated inside the challenge window', () => {
      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: 1_000_000,
          currentLedgerIndex: 1_000_002,
          expiresIso,
          maxChallengeLifetime,
          nowMs,
        }),
      ).not.toThrow()
    })

    it('rejects a transaction validated long before the challenge existed', () => {
      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: 990_000,
          currentLedgerIndex: 1_000_000,
          expiresIso,
          maxChallengeLifetime,
          nowMs,
        }),
      ).toThrow('predates')
    })

    it('anchors the floor on expires minus the assumed lifetime', () => {
      // 5-minute lifetime is ~75 ledgers at 4s, plus jitter slack. A tx that
      // old must pass; far older must not.
      const lifetimeLedgers = Math.ceil(maxChallengeLifetime / LEDGER_CLOSE_INTERVAL_MS)
      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: 1_000_000 - lifetimeLedgers,
          currentLedgerIndex: 1_000_000,
          expiresIso,
          maxChallengeLifetime,
          nowMs,
        }),
      ).not.toThrow()

      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: 1_000_000 - lifetimeLedgers - 100,
          currentLedgerIndex: 1_000_000,
          expiresIso,
          maxChallengeLifetime,
          nowMs,
        }),
      ).toThrow('predates')
    })

    it('tightens the floor when a shorter lifetime is configured', () => {
      // A 30s lifetime means a transaction from 5 minutes ago cannot belong to
      // this challenge, even though the default lifetime would have allowed it.
      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: 1_000_000 - 75,
          currentLedgerIndex: 1_000_000,
          expiresIso,
          maxChallengeLifetime: 30_000,
          nowMs,
        }),
      ).toThrow('predates')
    })

    it('is a no-op when the ledger index is unavailable', () => {
      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: undefined,
          currentLedgerIndex: 1_000_000,
          expiresIso,
          maxChallengeLifetime,
          nowMs,
        }),
      ).not.toThrow()
    })

    it('is a no-op when expires is unparseable', () => {
      expect(() =>
        assertTxNotOlderThanChallenge({
          txLedgerIndex: 1,
          currentLedgerIndex: 1_000_000,
          expiresIso: 'not-a-date',
          maxChallengeLifetime,
          nowMs,
        }),
      ).not.toThrow()
    })
  })
})
