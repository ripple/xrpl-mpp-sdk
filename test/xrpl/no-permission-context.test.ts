import { describe, expect, it } from 'vitest'
import { paymentMovedMpt } from '../../sdk/src/utils/schemas.js'

/**
 * `tecNO_PERMISSION` means one thing on an MPT payment and another on a Payment
 * to an account with deposit authorization set. The engine result does not say
 * which, so the distinction is drawn from the transaction that failed.
 *
 * Reading it off the response rather than threading a parameter matters: the
 * value cannot drift from the transaction it describes, and it works for both
 * response shapes rippled emits.
 */
const MPT = { mpt_issuance_id: '00000012A5E1C3F0B4D2', value: '10' }

describe('paymentMovedMpt', () => {
  it('reads the nested tx_json shape (api_version 2)', () => {
    expect(paymentMovedMpt({ tx_json: { Amount: MPT } })).toBe(true)
    expect(paymentMovedMpt({ tx_json: { Amount: '1000000' } })).toBe(false)
  })

  it('reads the flattened shape (api_version 1)', () => {
    expect(paymentMovedMpt({ Amount: MPT })).toBe(true)
    expect(paymentMovedMpt({ Amount: '1000000' })).toBe(false)
  })

  it('treats an issued currency as not an MPT', () => {
    const iou = { currency: 'USD', issuer: 'rIssuer', value: '10' }
    expect(paymentMovedMpt({ tx_json: { Amount: iou } })).toBe(false)
  })

  it('answers false rather than guessing when it cannot read the response', () => {
    // A wrong `true` would report a recipient's configuration as an MPT
    // problem, which is the failure this exists to prevent. Unknown must fall
    // back to the answer that holds either way.
    for (const raw of [null, undefined, {}, 'nonsense', { tx_json: {} }, { Amount: null }]) {
      expect(paymentMovedMpt(raw), JSON.stringify(raw ?? null)).toBe(false)
    }
  })

  it('prefers tx_json over the root when both are present', () => {
    expect(paymentMovedMpt({ tx_json: { Amount: MPT }, Amount: '1000000' })).toBe(true)
  })
})
