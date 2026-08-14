import { describe, expect, it } from 'vitest'
import { channel } from '../../sdk/src/channel/Methods.js'
import { charge } from '../../sdk/src/Methods.js'

describe('MPP Intent Schemas', () => {
  describe('charge intent', () => {
    it('has name "xrpl" and intent "charge"', () => {
      expect(charge.name).toBe('xrpl')
      expect(charge.intent).toBe('charge')
    })

    it('pull mode credential contains signed tx blob', () => {
      const payload = { blob: '1200002200000000', type: 'transaction' as const }
      const parsed = charge.schema.credential.payload.parse(payload)
      expect(parsed.type).toBe('transaction')
      expect((parsed as any).blob).toBe('1200002200000000')
    })

    it('push mode credential contains tx hash', () => {
      const payload = { hash: `A${'0'.repeat(63)}`, type: 'hash' as const }
      const parsed = charge.schema.credential.payload.parse(payload)
      expect(parsed.type).toBe('hash')
      expect((parsed as any).hash).toBe(`A${'0'.repeat(63)}`)
    })

    it('request schema contains all required fields', () => {
      const request = {
        amount: '1000000',
        currency: 'XRP',
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      }
      const parsed = charge.schema.request.parse(request)
      expect(parsed.amount).toBeDefined()
      expect(parsed.currency).toBeDefined()
      expect(parsed.recipient).toBeDefined()
    })

    it('request schema supports methodDetails with network', () => {
      const request = {
        amount: '1000000',
        currency: 'XRP',
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        methodDetails: {
          network: 'testnet',
          invoiceId: 'A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
        },
      }
      const parsed = charge.schema.request.parse(request)
      expect(parsed.methodDetails?.network).toBe('testnet')
    })
  })

  describe('channel intent', () => {
    it('has name "xrpl" and the canonical MPP intent "session"', () => {
      // mpp.dev defines the pay-as-you-go / payment-channel flow under the
      // canonical `session` intent. The XRPL PayChannel mechanism keeps the
      // "channel" name internally, but the wire intent must be `session`.
      expect(channel.name).toBe('xrpl')
      expect(channel.intent).toBe('session')
    })

    it('request schema carries a currency field (session intent requires it)', () => {
      const parsed = channel.schema.request.parse({
        amount: '500000',
        channelId: '0'.repeat(64),
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        currency: 'XRP',
      })
      expect((parsed as { currency?: string }).currency).toBe('XRP')
    })

    it('open credential contains transaction blob, amount, signature', () => {
      const payload = {
        action: 'open' as const,
        transaction: '1200002200000000DEADBEEF',
        amount: '100000',
        signature: 'abcdef1234567890'.repeat(8),
      }
      const parsed = channel.schema.credential.payload.parse(payload)
      expect((parsed as any).action).toBe('open')
      expect((parsed as any).transaction).toBe('1200002200000000DEADBEEF')
    })

    it('voucher credential contains channelId, cumulative amount, signature', () => {
      const payload = {
        action: 'voucher' as const,
        channelId: '0'.repeat(64),
        amount: '500000',
        signature: 'abcdef1234567890'.repeat(8),
      }
      const parsed = channel.schema.credential.payload.parse(payload)
      expect((parsed as any).action).toBe('voucher')
      expect((parsed as any).channelId).toBe('0'.repeat(64))
      expect((parsed as any).amount).toBe('500000')
    })

    it('close credential contains channelId, cumulative amount, signature', () => {
      const payload = {
        action: 'close' as const,
        channelId: '0'.repeat(64),
        amount: '1000000',
        signature: 'abcdef1234567890'.repeat(8),
      }
      const parsed = channel.schema.credential.payload.parse(payload)
      expect((parsed as any).action).toBe('close')
    })

    it('request schema contains amount, channelId, recipient', () => {
      const request = {
        amount: '100000',
        channelId: '0'.repeat(64),
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      }
      const parsed = channel.schema.request.parse(request)
      expect(parsed.amount).toBeDefined()
      expect(parsed.channelId).toBeDefined()
      expect(parsed.recipient).toBeDefined()
    })

    it('request schema supports methodDetails with cumulativeAmount', () => {
      const request = {
        amount: '100000',
        channelId: '0'.repeat(64),
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        methodDetails: {
          network: 'testnet',
          cumulativeAmount: '500000',
        },
      }
      const parsed = channel.schema.request.parse(request)
      expect(parsed.methodDetails?.cumulativeAmount).toBe('500000')
    })

    it('rejects non-numeric amount in credential', () => {
      const payload = {
        action: 'voucher' as const,
        channelId: '0'.repeat(64),
        amount: 'not-a-number',
        signature: 'abcdef1234567890'.repeat(8),
      }
      expect(() => channel.schema.credential.payload.parse(payload)).toThrow()
    })

    it('rejects non-hex signature in credential', () => {
      const payload = {
        action: 'voucher' as const,
        channelId: '0'.repeat(64),
        amount: '100000',
        signature: 'not-hex!@#$',
      }
      expect(() => channel.schema.credential.payload.parse(payload)).toThrow()
    })
  })
})
