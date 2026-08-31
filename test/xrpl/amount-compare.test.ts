import { describe, expect, it } from 'vitest'
import { canonicalDecimal, sameAmount } from '../../sdk/src/utils/amount.js'

/**
 * The ledger rewrites issued-currency values into its own canonical form, so a
 * Payment challenged at "1.10" settles and is reported as "1.1". Comparing the
 * two as strings refused a payment that had settled exactly as asked -- and in
 * push mode the money was already gone, bound by its InvoiceID to the challenge
 * being refused.
 */

describe('canonicalDecimal', () => {
  it('collapses the forms the ledger actually produces', () => {
    expect(canonicalDecimal('1.10')).toBe('1.1')
    expect(canonicalDecimal('10.0')).toBe('10')
    expect(canonicalDecimal('10')).toBe('10')
  })

  it('normalises leading and trailing zeros', () => {
    expect(canonicalDecimal('01000000')).toBe('1000000')
    expect(canonicalDecimal('0.100')).toBe('0.1')
    expect(canonicalDecimal('.5')).toBe('0.5')
    expect(canonicalDecimal('5.')).toBe('5')
  })

  it('has one representation of zero', () => {
    for (const z of ['0', '0.0', '00', '-0', '0.000', '.0']) expect(canonicalDecimal(z)).toBe('0')
  })

  it('keeps digits beyond float precision intact', () => {
    // The whole point of doing this on strings: a number round trip loses these.
    expect(canonicalDecimal('9007199254740993')).toBe('9007199254740993')
    expect(canonicalDecimal('1.000000000000000000001')).toBe('1.000000000000000000001')
  })

  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', '1e6', '1E6', 'abc', '1.2.3', '1 000', 'NaN', 'Infinity', '0x10']) {
      expect(canonicalDecimal(bad), bad).toBeNull()
    }
  })
})

describe('sameAmount', () => {
  it('accepts the ledger rewriting a challenged value', () => {
    expect(sameAmount('1.10', '1.1')).toBe(true)
    expect(sameAmount('10.0', '10')).toBe(true)
    expect(sameAmount('1000000', '1000000')).toBe(true)
  })

  it('still rejects a genuine mismatch', () => {
    expect(sameAmount('1.1', '1.2')).toBe(false)
    expect(sameAmount('10', '100')).toBe(false)
    expect(sameAmount('1', '0.1')).toBe(false)
    // Not the same value, and the digits are beyond float resolution.
    expect(sameAmount('9007199254740993', '9007199254740994')).toBe(false)
  })

  it('treats an unreadable amount as not matching', () => {
    // Fail closed: an amount the SDK cannot parse must never compare equal.
    expect(sameAmount('1e6', '1000000')).toBe(false)
    expect(sameAmount('1000000', '1e6')).toBe(false)
    expect(sameAmount('', '0')).toBe(false)
  })
})

describe('validatePaymentFields accepts a ledger-normalised IOU value', () => {
  it('no longer refuses "1.10" challenged against "1.1" settled', async () => {
    const { validatePaymentFields } = await import('../../sdk/src/server/Charge.js')
    const issuer = 'rwzRswng9sqR9Buw2T8FG18K4n8xdd1dCa'
    const payer = 'rBkRQZrL4K8Rg2Bg2UzyQUSzYyNeBAK95Z'
    const recipient = 'rhewi79quXUDwcqjkpj4bXuw3cuHYC9fwv'

    const tx = {
      TransactionType: 'Payment',
      Account: payer,
      Destination: recipient,
      // What the ledger reports after normalising the challenged "1.10".
      Amount: { currency: 'USD', issuer, value: '1.1' },
    }

    expect(() =>
      validatePaymentFields(tx, {
        amount: '1.10',
        recipient,
        currency: { currency: 'USD', issuer },
        sender: payer,
        invoiceIdRequired: false,
      }),
    ).not.toThrow()
  })

  it('still refuses a real mismatch', () => {
    // Guard against the fix turning into "accept anything".
    expect(sameAmount('1.10', '1.2')).toBe(false)
  })
})
