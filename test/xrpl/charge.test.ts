import { Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { fromTecResult, mapTecResult } from '../../sdk/src/errors.js'
import { charge, fromDrops, toDrops } from '../../sdk/src/Methods.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

describe('XRPL Charge', () => {
  describe('toDrops / fromDrops', () => {
    it('converts 1 XRP to 1000000 drops', () => {
      expect(toDrops('1')).toBe('1000000')
    })

    it('converts 0.001 XRP to 1000 drops', () => {
      expect(toDrops('0.001')).toBe('1000')
    })

    it('converts 0.000001 XRP to 1 drop', () => {
      expect(toDrops('0.000001')).toBe('1')
    })

    it('converts 100 XRP to 100000000 drops', () => {
      expect(toDrops('100')).toBe('100000000')
    })

    it('handles negative amounts', () => {
      expect(toDrops('-1')).toBe('-1000000')
    })

    it('converts 1000000 drops to 1.000000 XRP', () => {
      expect(fromDrops('1000000')).toBe('1.000000')
    })

    it('converts 1 drop to 0.000001 XRP', () => {
      expect(fromDrops('1')).toBe('0.000001')
    })

    it('converts 0 drops to 0.000000', () => {
      expect(fromDrops('0')).toBe('0.000000')
    })

    it('roundtrips correctly', () => {
      expect(fromDrops(toDrops('12.345678'))).toBe('12.345678')
      expect(fromDrops(toDrops('0.000001'))).toBe('0.000001')
      expect(fromDrops(toDrops('1000'))).toBe('1000.000000')
    })
  })

  describe('tecResult mapping', () => {
    it('maps tecPATH_DRY to PAYMENT_PATH_FAILED', () => {
      expect(mapTecResult('tecPATH_DRY')).toBe('PAYMENT_PATH_FAILED')
    })

    it('maps tecUNFUNDED_PAYMENT to INSUFFICIENT_BALANCE', () => {
      expect(mapTecResult('tecUNFUNDED_PAYMENT')).toBe('INSUFFICIENT_BALANCE')
    })

    it('maps tecNO_DST to RECIPIENT_NOT_FOUND', () => {
      expect(mapTecResult('tecNO_DST')).toBe('RECIPIENT_NOT_FOUND')
    })

    it('maps tecNO_AUTH to TRUSTLINE_NOT_AUTHORIZED', () => {
      expect(mapTecResult('tecNO_AUTH')).toBe('TRUSTLINE_NOT_AUTHORIZED')
    })

    it('maps tecNO_LINE to MISSING_TRUSTLINE', () => {
      expect(mapTecResult('tecNO_LINE')).toBe('MISSING_TRUSTLINE')
    })

    it('maps temBAD_AMOUNT to INVALID_AMOUNT', () => {
      expect(mapTecResult('temBAD_AMOUNT')).toBe('INVALID_AMOUNT')
    })

    it('maps terINSUF_FEE_B to INSUFFICIENT_FEE', () => {
      expect(mapTecResult('terINSUF_FEE_B')).toBe('INSUFFICIENT_FEE')
    })

    it('maps tecINSUFFICIENT_RESERVE to INSUFFICIENT_RESERVE', () => {
      expect(mapTecResult('tecINSUFFICIENT_RESERVE')).toBe('INSUFFICIENT_RESERVE')
    })

    it('maps tefPAST_SEQ to SUBMISSION_FAILED', () => {
      expect(mapTecResult('tefPAST_SEQ')).toBe('SUBMISSION_FAILED')
    })

    it('maps tecPATH_PARTIAL to PAYMENT_PATH_FAILED (path liquidity issue, not balance)', () => {
      expect(mapTecResult('tecPATH_PARTIAL')).toBe('PAYMENT_PATH_FAILED')
    })

    // tecNO_PERMISSION has more than one cause and the result code does not say
    // which. Without context the mapping must not pick one: reporting a
    // recipient's deposit-authorization setting as an MPT problem points the
    // operator at the wrong account.
    it('maps tecNO_PERMISSION to DESTINATION_PERMISSION_DENIED without context', () => {
      expect(mapTecResult('tecNO_PERMISSION')).toBe('DESTINATION_PERMISSION_DENIED')
    })

    it('narrows tecNO_PERMISSION to MPT_NOT_AUTHORIZED when the payment moved an MPT', () => {
      expect(mapTecResult('tecNO_PERMISSION', { mpt: true })).toBe('MPT_NOT_AUTHORIZED')
    })

    it('does not narrow when the context says the payment was not an MPT', () => {
      expect(mapTecResult('tecNO_PERMISSION', { mpt: false })).toBe('DESTINATION_PERMISSION_DENIED')
    })

    it('leaves every other result unaffected by context', () => {
      // The narrowing is specific to one ambiguous result, not a general
      // override that could reshape unrelated mappings.
      for (const tec of ['tecPATH_DRY', 'tecNO_DST', 'tecMPT_NOT_AUTHORIZED', 'temBAD_AMOUNT']) {
        expect(mapTecResult(tec, { mpt: true }), tec).toBe(mapTecResult(tec))
      }
    })

    it('names deposit authorization as the usual cause without asserting it', () => {
      const error = fromTecResult('tecNO_PERMISSION', 'Transaction ABC did not succeed')
      expect(error.message).toContain('DESTINATION_PERMISSION_DENIED')
      expect(error.message).toContain('lsfDepositAuth')
      expect(error.message).toContain('usual cause')
      // The recipient's configuration, not the payer's payment.
      expect(error.message).toContain('not a problem with the payment')
    })

    it('still reports the MPT cause when the payment carried an MPT', () => {
      const error = fromTecResult('tecNO_PERMISSION', 'submit failed', { mpt: true })
      expect(error.message).toContain('MPT_NOT_AUTHORIZED')
      expect(error.message).not.toContain('lsfDepositAuth')
    })

    it('maps tecINSUFF_FEE to INSUFFICIENT_FEE', () => {
      expect(mapTecResult('tecINSUFF_FEE')).toBe('INSUFFICIENT_FEE')
    })

    it('maps tecFROZEN to TRUSTLINE_FROZEN', () => {
      expect(mapTecResult('tecFROZEN')).toBe('TRUSTLINE_FROZEN')
    })

    it('maps tefBAD_AUTH to INVALID_SIGNATURE', () => {
      expect(mapTecResult('tefBAD_AUTH')).toBe('INVALID_SIGNATURE')
    })

    it('returns undefined for unknown tecResult', () => {
      expect(mapTecResult('tecUNKNOWN_CODE')).toBeUndefined()
    })
  })

  describe('fromTecResult error construction', () => {
    it('creates InsufficientBalanceError for tecUNFUNDED_PAYMENT', () => {
      const err = fromTecResult('tecUNFUNDED_PAYMENT', 'Not enough XRP')
      expect(err.message).toContain('INSUFFICIENT_BALANCE')
      expect(err.message).toContain('tecUNFUNDED_PAYMENT')
    })

    it('creates VerificationFailedError for tecPATH_DRY', () => {
      const err = fromTecResult('tecPATH_DRY')
      expect(err.message).toContain('PAYMENT_PATH_FAILED')
    })

    it('creates VerificationFailedError for terINSUF_FEE_B', () => {
      const err = fromTecResult('terINSUF_FEE_B')
      expect(err.message).toContain('INSUFFICIENT_FEE')
    })

    it('creates VerificationFailedError for tecPATH_PARTIAL', () => {
      const err = fromTecResult('tecPATH_PARTIAL')
      expect(err.message).toContain('PAYMENT_PATH_FAILED')
    })

    it('creates VerificationFailedError for tecNO_PERMISSION', () => {
      const err = fromTecResult('tecNO_PERMISSION')
      expect(err.message).toContain('DESTINATION_PERMISSION_DENIED')
    })

    it('creates VerificationFailedError with SUBMISSION_FAILED for unknown tec', () => {
      const err = fromTecResult('tecSOMETHING_ELSE')
      expect(err.message).toContain('SUBMISSION_FAILED')
    })
  })

  describe('Partial payment defense', () => {
    it('tfPartialPayment flag is 0x00020000', () => {
      const tx = { Flags: 0x00020000 }
      expect(tx.Flags & 0x00020000).not.toBe(0)
    })

    it('delivered_amount takes precedence over Amount', () => {
      const meta = { TransactionResult: 'tesSUCCESS', delivered_amount: '500000' }
      const tx = { Amount: '1000000' }
      const effectiveAmount = meta.delivered_amount ?? tx.Amount
      expect(effectiveAmount).toBe('500000')
    })
  })

  describe('Charge schema', () => {
    it('pull mode: blob is a string', () => {
      const parsed = charge.schema.credential.payload.parse({
        blob: '1200002200000000',
        type: 'transaction',
      })
      expect(parsed).toEqual({ blob: '1200002200000000', type: 'transaction' })
    })

    it('push mode: hash is a string', () => {
      const parsed = charge.schema.credential.payload.parse({
        hash: 'A'.repeat(64),
        type: 'hash',
      })
      expect(parsed).toEqual({ hash: 'A'.repeat(64), type: 'hash' })
    })
  })

  describe('Server seed/recipient validation', () => {
    it('throws when wallet does not match recipient', async () => {
      const { charge: serverCharge } = await import('../../sdk/src/server/Charge.js')
      const wallet = Wallet.generate()

      expect(() =>
        serverCharge({
          recipient: 'r37fNt5c4FdRwFzEBUToqySeLGFBKnqAuT',
          wallet,
          autoTrustline: true,
          network: 'testnet',
          store: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
        }),
      ).toThrow('does not match recipient')
    })

    it('throws when autoTrustline is set without wallet/seed', async () => {
      const { charge: serverCharge } = await import('../../sdk/src/server/Charge.js')

      expect(() =>
        serverCharge({
          recipient: 'rSomeAddress123',
          autoTrustline: true,
          network: 'testnet',
          store: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
        }),
      ).toThrow('wallet (or seed) is required')
    })

    it('accepts matching wallet and recipient', async () => {
      const { charge: serverCharge } = await import('../../sdk/src/server/Charge.js')
      const wallet = Wallet.generate()

      expect(() =>
        serverCharge({
          recipient: wallet.address,
          wallet,
          autoTrustline: true,
          currency: { currency: 'USD', issuer: 'rIssuer123' },
          network: 'testnet',
          store: Store.memory(),
          storeDurability: 'process-local',
        }),
      ).not.toThrow()
    })

    it('rejects a store without atomic compare-and-set', async () => {
      const { charge: serverCharge } = await import('../../sdk/src/server/Charge.js')

      // get/put/delete only: replay protection would degrade to a
      // time-of-check / time-of-use race, so construction must fail.
      expect(() =>
        serverCharge({
          recipient: 'rSomeAddress123',
          network: 'testnet',
          store: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
        }),
      ).toThrow('atomic compare-and-set')
    })
  })
})
