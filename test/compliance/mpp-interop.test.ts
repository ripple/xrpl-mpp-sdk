import { Credential, Receipt } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel } from '../../sdk/src/channel/Methods.js'
import { charge } from '../../sdk/src/Methods.js'
import { createMockChannelChallenge, createMockChargeChallenge } from '../utils/test-helpers.js'

describe('MPP Interop with mppx', () => {
  describe('Method registration', () => {
    it('charge method is a valid Method', () => {
      // Method.from returns the same object -- it is a type-level identity
      expect(charge.name).toBe('xrpl')
      expect(charge.intent).toBe('charge')
      expect(charge.schema).toBeDefined()
      expect(charge.schema.credential).toBeDefined()
      expect(charge.schema.request).toBeDefined()
    })

    it('channel method is a valid Method', () => {
      expect(channel.name).toBe('xrpl')
      expect(channel.intent).toBe('session')
      expect(channel.schema).toBeDefined()
    })
  })

  describe('Credential round-trip', () => {
    it('xrpl charge credential is serializable and deserializable by mppx', () => {
      const challenge = createMockChargeChallenge()
      const payload = { blob: '1200002200000000DEADBEEF', type: 'transaction' as const }

      const credential = Credential.from({
        challenge: challenge as any,
        payload,
        source: 'did:pkh:xrpl:testnet:rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      })

      const serialized = Credential.serialize(credential)
      expect(serialized).toMatch(/^Payment\s+/)

      const deserialized = Credential.deserialize(serialized)
      expect(deserialized.challenge.method).toBe('xrpl')
      expect(deserialized.challenge.intent).toBe('charge')
      expect(deserialized.payload).toEqual(payload)
      expect(deserialized.source).toBe('did:pkh:xrpl:testnet:rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9')
    })

    it('xrpl channel credential is serializable and deserializable by mppx', () => {
      const challenge = createMockChannelChallenge()
      const payload = {
        action: 'voucher' as const,
        channelId: '0'.repeat(64),
        amount: '500000',
        signature: 'ab'.repeat(64),
      }

      const credential = Credential.from({
        challenge: challenge as any,
        payload,
      })

      const serialized = Credential.serialize(credential)
      const deserialized = Credential.deserialize(serialized)
      expect(deserialized.challenge.method).toBe('xrpl')
      expect(deserialized.challenge.intent).toBe('channel')
      expect(deserialized.payload).toEqual(payload)
    })
  })

  describe('Challenge schema validation', () => {
    it('xrpl charge challenge request is parseable by charge schema', () => {
      const challenge = createMockChargeChallenge({
        amount: '2000000',
        currency: 'XRP',
        recipient: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      })
      const parsed = charge.schema.request.parse(challenge.request)
      expect(parsed.amount).toBe('2000000')
      expect(parsed.currency).toBe('XRP')
      expect(parsed.recipient).toBe('rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe')
    })
  })

  describe('Receipt compatibility', () => {
    it('xrpl receipt matches mppx Receipt schema', () => {
      const receipt = Receipt.from({
        method: 'xrpl',
        reference: `A${'0'.repeat(63)}`,
        status: 'success',
        timestamp: new Date().toISOString(),
      })

      expect(receipt.method).toBe('xrpl')
      expect(receipt.status).toBe('success')
      expect(receipt.reference).toBe(`A${'0'.repeat(63)}`)
    })

    it('receipt with externalId roundtrips', () => {
      const receipt = Receipt.from({
        method: 'xrpl',
        reference: 'ABC123',
        status: 'success',
        timestamp: new Date().toISOString(),
        externalId: 'order-456',
      })

      const encoded = Receipt.serialize(receipt)
      const decoded = Receipt.deserialize(encoded)
      expect(decoded.externalId).toBe('order-456')
    })
  })
})
