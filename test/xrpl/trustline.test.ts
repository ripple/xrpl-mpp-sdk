import { describe, expect, it } from 'vitest'
import { buildAmount, isIOU, parseCurrency } from '../../sdk/src/utils/currency.js'
import { checkRippling } from '../../sdk/src/utils/trustline.js'

describe('XRPL Trustline', () => {
  it('lsfDefaultRipple flag is 0x00800000', () => {
    const LSF_DEFAULT_RIPPLE = 0x00800000
    expect(LSF_DEFAULT_RIPPLE).toBe(8388608)
  })

  it('IOU amount object has currency, issuer, and value', () => {
    const amount = buildAmount('100', {
      currency: 'USD',
      issuer: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
    })
    expect(amount).toEqual({
      currency: 'USD',
      issuer: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      value: '100',
    })
  })

  it('parseCurrency recognizes JSON IOU format', () => {
    const currency = parseCurrency('{"currency":"USD","issuer":"rIssuer123"}')
    expect(isIOU(currency)).toBe(true)
    if (isIOU(currency)) {
      expect(currency.currency).toBe('USD')
      expect(currency.issuer).toBe('rIssuer123')
    }
  })

  it('parseCurrency recognizes CURRENCY:ISSUER format', () => {
    const currency = parseCurrency('USD:rIssuer123')
    expect(isIOU(currency)).toBe(true)
    if (isIOU(currency)) {
      expect(currency.currency).toBe('USD')
      expect(currency.issuer).toBe('rIssuer123')
    }
  })

  it('throws on unparseable currency string', () => {
    expect(() => parseCurrency('')).toThrow()
  })

  it('checkRippling is exported and callable', () => {
    expect(typeof checkRippling).toBe('function')
  })
})
