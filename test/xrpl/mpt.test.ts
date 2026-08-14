import { describe, expect, it } from 'vitest'
import { buildAmount, isMPT, parseCurrency } from '../../sdk/src/utils/currency.js'

describe('XRPL MPT (Multi-Purpose Token)', () => {
  const mptIssuanceId = '00000001A407AF5856CEFB379FAE300376E06FCEEDDC455BE0'

  it('MPT amount uses mpt_issuance_id', () => {
    const amount = buildAmount('100', { mpt_issuance_id: mptIssuanceId })
    expect(amount).toEqual({ mpt_issuance_id: mptIssuanceId, value: '100' })
  })

  it('parseCurrency recognizes JSON MPT format', () => {
    const currency = parseCurrency(`{"mpt_issuance_id":"${mptIssuanceId}"}`)
    expect(isMPT(currency)).toBe(true)
    if (isMPT(currency)) {
      expect(currency.mpt_issuance_id).toBe(mptIssuanceId)
    }
  })

  it('mpt_issuance_id is 48+ hex characters', () => {
    expect(mptIssuanceId.length).toBeGreaterThanOrEqual(48)
    expect(mptIssuanceId).toMatch(/^[0-9A-Fa-f]+$/)
  })

  it('isMPT distinguishes MPT from IOU and XRP', () => {
    expect(isMPT('XRP')).toBe(false)
    expect(isMPT({ currency: 'USD', issuer: 'r123' })).toBe(false)
    expect(isMPT({ mpt_issuance_id: mptIssuanceId })).toBe(true)
  })
})
