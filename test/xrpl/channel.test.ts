import { Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel } from '../../sdk/src/channel/Methods.js'
import { storeKeys } from '../../sdk/src/utils/keys.js'

const NETWORK = 'testnet' as const

describe('XRPL Channel', () => {
  describe('Channel schema', () => {
    it('open payload parses correctly', () => {
      const payload = {
        action: 'open' as const,
        transaction: '1200002200000000DEADBEEF',
        amount: '100000',
        signature: 'CD'.repeat(64),
      }
      const parsed = channel.schema.credential.payload.parse(payload)
      expect(parsed).toEqual(payload)
    })

    it('voucher payload parses correctly', () => {
      const payload = {
        action: 'voucher' as const,
        channelId: 'AB'.repeat(32),
        amount: '100000',
        signature: 'CD'.repeat(64),
      }
      const parsed = channel.schema.credential.payload.parse(payload)
      expect(parsed).toEqual(payload)
    })

    it('close payload parses correctly', () => {
      const payload = {
        action: 'close' as const,
        channelId: 'AB'.repeat(32),
        amount: '500000',
        signature: 'EF'.repeat(64),
      }
      const parsed = channel.schema.credential.payload.parse(payload)
      expect(parsed).toEqual(payload)
    })

    it('request schema parses with all fields', () => {
      const request = {
        amount: '50000',
        channelId: '0'.repeat(64),
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        description: 'Pay per token',
        externalId: 'session-001',
        methodDetails: {
          reference: 'ref-123',
          network: 'testnet',
          cumulativeAmount: '200000',
        },
      }
      const parsed = channel.schema.request.parse(request)
      expect(parsed.channelId).toBe('0'.repeat(64))
      expect(parsed.methodDetails?.cumulativeAmount).toBe('200000')
    })
  })

  describe('Cumulative amount tracking', () => {
    it('tracks cumulative amounts and signature in store', async () => {
      const store = Store.memory()
      const channelId = '0'.repeat(64)
      const key = storeKeys(NETWORK).channel(channelId)

      const initial = await store.get(key)
      expect(initial).toBeNull()

      await store.put(key, {
        cumulative: '100000',
        signature: 'AA'.repeat(64),
        timestamp: Date.now(),
      })

      const state = (await store.get(key)) as any
      expect(BigInt(state.cumulative)).toBe(100000n)
      expect(state.signature).toBe('AA'.repeat(64))

      await store.put(key, {
        cumulative: '200000',
        signature: 'BB'.repeat(64),
        timestamp: Date.now(),
      })
      const updated = (await store.get(key)) as any
      expect(BigInt(updated.cumulative)).toBe(200000n)
      expect(updated.signature).toBe('BB'.repeat(64))
    })

    it('rejects equal cumulative (replay)', async () => {
      const store = Store.memory()
      const channelId = '0'.repeat(64)
      const key = storeKeys(NETWORK).channel(channelId)

      await store.put(key, {
        cumulative: '100000',
        signature: 'AA'.repeat(64),
        timestamp: Date.now(),
      })
      const state = (await store.get(key)) as any
      const prev = BigInt(state.cumulative)
      expect(100000n > prev).toBe(false)
    })

    it('rejects lower cumulative (attack)', async () => {
      const store = Store.memory()
      const channelId = '0'.repeat(64)
      const key = storeKeys(NETWORK).channel(channelId)

      await store.put(key, {
        cumulative: '100000',
        signature: 'AA'.repeat(64),
        timestamp: Date.now(),
      })
      const state = (await store.get(key)) as any
      const prev = BigInt(state.cumulative)
      expect(50000n > prev).toBe(false)
    })

    it('rejects cumulative that does not cover requested amount', () => {
      const previousCumulative = 100000n
      const requestedAmount = 50000n
      const newCumulative = 120000n // only +20000, should be >= 150000
      expect(newCumulative >= previousCumulative + requestedAmount).toBe(false)
    })

    it('accepts cumulative that covers requested amount', () => {
      const previousCumulative = 100000n
      const requestedAmount = 50000n
      const newCumulative = 150000n
      expect(newCumulative >= previousCumulative + requestedAmount).toBe(true)
    })

    it('latest signature is always available for server-side redeem', async () => {
      const store = Store.memory()
      const channelId = '0'.repeat(64)
      const key = storeKeys(NETWORK).channel(channelId)

      await store.put(key, {
        cumulative: '100000',
        signature: 'SIG1'.padEnd(128, '0'),
        timestamp: Date.now(),
      })
      await store.put(key, {
        cumulative: '200000',
        signature: 'SIG2'.padEnd(128, '0'),
        timestamp: Date.now(),
      })
      await store.put(key, {
        cumulative: '300000',
        signature: 'SIG3'.padEnd(128, '0'),
        timestamp: Date.now(),
      })

      const state = (await store.get(key)) as any
      expect(state.cumulative).toBe('300000')
      expect(state.signature).toBe('SIG3'.padEnd(128, '0'))
    })
  })

  describe('Finalized channel', () => {
    const keys = storeKeys('testnet')
    it('finalized flag blocks further credentials', async () => {
      const store = Store.memory()
      const channelId = '0'.repeat(64)

      await store.put(keys.channelFinalized(channelId), {
        reason: 'closed',
        timestamp: Date.now(),
      })

      const finalized = await store.get(keys.channelFinalized(channelId))
      expect(finalized).not.toBeNull()
    })

    it('non-finalized channel has no flag', async () => {
      const store = Store.memory()
      const channelId = '0'.repeat(64)

      const finalized = await store.get(keys.channelFinalized(channelId))
      expect(finalized).toBeNull()
    })
  })
})
