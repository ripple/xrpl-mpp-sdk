import { Credential, Errors, Receipt } from 'mppx'
import { describe, expect, it } from 'vitest'
import { charge as chargeMethods } from '../../sdk/src/Methods.js'
import { createMockChargeChallenge } from '../utils/test-helpers.js'

describe('MPP Protocol Compliance', () => {
  describe('402 Challenge Response', () => {
    it('method schema has name "xrpl" and intent "charge"', () => {
      expect(chargeMethods.name).toBe('xrpl')
      expect(chargeMethods.intent).toBe('charge')
    })

    it('charge method schema defines required request fields', () => {
      const challenge = createMockChargeChallenge()
      // Validate the request parses through the schema
      const parsed = chargeMethods.schema.request.parse(challenge.request)
      expect(parsed.amount).toBe('1000000')
      expect(parsed.currency).toBe('XRP')
      expect(parsed.recipient).toBe('rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9')
    })

    it('charge method schema defines credential payload with discriminated union', () => {
      // Pull mode
      const pullPayload = { blob: 'DEADBEEF', type: 'transaction' as const }
      const parsedPull = chargeMethods.schema.credential.payload.parse(pullPayload)
      expect(parsedPull.type).toBe('transaction')

      // Push mode
      const pushPayload = { hash: 'AB'.repeat(32), type: 'hash' as const }
      const parsedPush = chargeMethods.schema.credential.payload.parse(pushPayload)
      expect(parsedPush.type).toBe('hash')
    })

    it('rejects unknown payload type', () => {
      const badPayload = { data: 'x', type: 'unknown' }
      expect(() => chargeMethods.schema.credential.payload.parse(badPayload)).toThrow()
    })

    it('challenge contains required fields: method, intent, amount, currency, recipient', () => {
      const challenge = createMockChargeChallenge()
      expect(challenge.method).toBe('xrpl')
      expect(challenge.intent).toBe('charge')
      expect(challenge.request.amount).toBeDefined()
      expect(challenge.request.currency).toBeDefined()
      expect(challenge.request.recipient).toBeDefined()
    })

    it('server ignores unknown fields in credential (forward-compatible)', () => {
      const challenge = createMockChargeChallenge()
      const request = {
        ...challenge.request,
        unknownField: 'should-be-ignored',
        anotherExtra: 42,
      }
      // Schema should still parse -- unknown fields are stripped
      const parsed = chargeMethods.schema.request.parse(request)
      expect(parsed.amount).toBe(challenge.request.amount)
    })
  })

  describe('Challenge Schema Validation', () => {
    it('rejects missing amount', () => {
      expect(() =>
        chargeMethods.schema.request.parse({
          currency: 'XRP',
          recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        }),
      ).toThrow()
    })

    it('rejects missing currency', () => {
      expect(() =>
        chargeMethods.schema.request.parse({
          amount: '1000000',
          recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        }),
      ).toThrow()
    })

    it('rejects missing recipient', () => {
      expect(() =>
        chargeMethods.schema.request.parse({
          amount: '1000000',
          currency: 'XRP',
        }),
      ).toThrow()
    })

    it('accepts optional description and externalId', () => {
      const parsed = chargeMethods.schema.request.parse({
        amount: '1000000',
        currency: 'XRP',
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        description: 'Test payment',
        externalId: 'order-123',
      })
      expect(parsed.description).toBe('Test payment')
      expect(parsed.externalId).toBe('order-123')
    })

    it('accepts optional methodDetails with network and reference', () => {
      const parsed = chargeMethods.schema.request.parse({
        amount: '1000000',
        currency: 'XRP',
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        methodDetails: {
          network: 'testnet',
          reference: 'ref-abc',
          invoiceId: 'A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
        },
      })
      expect(parsed.methodDetails?.network).toBe('testnet')
      expect(parsed.methodDetails?.reference).toBe('ref-abc')
    })
  })

  describe('Credential Serialization', () => {
    it('Credential.serialize produces "Payment ..." string', () => {
      const challenge = createMockChargeChallenge()
      const credential = Credential.from({
        challenge: challenge as any,
        payload: { blob: 'DEADBEEF', type: 'transaction' },
      })
      const header = Credential.serialize(credential)
      expect(header).toMatch(/^Payment\s+/)
    })

    it('Credential.deserialize roundtrips', () => {
      const challenge = createMockChargeChallenge()
      const credential = Credential.from({
        challenge: challenge as any,
        payload: { blob: 'DEADBEEF', type: 'transaction' },
      })
      const header = Credential.serialize(credential)
      const parsed = Credential.deserialize(header)
      expect(parsed.payload).toEqual({ blob: 'DEADBEEF', type: 'transaction' })
      expect(parsed.challenge.method).toBe('xrpl')
      expect(parsed.challenge.intent).toBe('charge')
    })
  })

  describe('Receipt Format', () => {
    it('Receipt.from creates a valid receipt', () => {
      const receipt = Receipt.from({
        method: 'xrpl',
        reference: 'ABC123DEF456',
        status: 'success',
        timestamp: new Date().toISOString(),
      })
      expect(receipt.method).toBe('xrpl')
      expect(receipt.reference).toBe('ABC123DEF456')
      expect(receipt.status).toBe('success')
    })

    it('Receipt.serialize/deserialize roundtrips', () => {
      const receipt = Receipt.from({
        method: 'xrpl',
        reference: 'ABC123',
        status: 'success',
        timestamp: new Date().toISOString(),
      })
      const encoded = Receipt.serialize(receipt)
      const decoded = Receipt.deserialize(encoded)
      expect(decoded.method).toBe('xrpl')
      expect(decoded.reference).toBe('ABC123')
    })
  })

  describe('Error Types (RFC 9457)', () => {
    it('MalformedCredentialError has correct type and status', () => {
      const err = new Errors.MalformedCredentialError({ reason: 'invalid base64url' })
      expect(err.type).toBe('https://paymentauth.org/problems/malformed-credential')
      expect(err.status).toBe(402)
      const pd = err.toProblemDetails()
      expect(pd.type).toBe('https://paymentauth.org/problems/malformed-credential')
      expect(pd.detail).toContain('invalid base64url')
    })

    it('VerificationFailedError has correct type and status', () => {
      const err = new Errors.VerificationFailedError({ reason: 'amount mismatch' })
      expect(err.type).toBe('https://paymentauth.org/problems/verification-failed')
      expect(err.status).toBe(402)
    })

    it('InvalidChallengeError has correct type', () => {
      const err = new Errors.InvalidChallengeError({ reason: 'expired' })
      expect(err.type).toBe('https://paymentauth.org/problems/invalid-challenge')
    })

    it('InsufficientBalanceError has correct type', () => {
      const err = new Errors.InsufficientBalanceError({ reason: 'underfunded' })
      expect(err.type).toBe('https://paymentauth.org/problems/session/insufficient-balance')
    })

    it('InvalidSignatureError has correct type', () => {
      const err = new Errors.InvalidSignatureError({ reason: 'wrong key' })
      expect(err.type).toBe('https://paymentauth.org/problems/session/invalid-signature')
    })

    it('ChannelNotFoundError has status 410', () => {
      const err = new Errors.ChannelNotFoundError({ reason: 'unknown channel' })
      expect(err.status).toBe(410)
      expect(err.type).toBe('https://paymentauth.org/problems/session/channel-not-found')
    })

    it('ChannelClosedError has status 410', () => {
      const err = new Errors.ChannelClosedError({ reason: 'already finalized' })
      expect(err.status).toBe(410)
      expect(err.type).toBe('https://paymentauth.org/problems/session/channel-finalized')
    })
  })
})
