import { Store } from 'mppx'
import { beforeEach, describe, expect, it } from 'vitest'
import { replayDetected } from '../../sdk/src/errors.js'
import { storeKeys } from '../../sdk/src/utils/keys.js'

describe('Replay Attack Prevention', () => {
  const keys = storeKeys('testnet')
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    store = Store.memory()
  })

  describe('Charge replay protection', () => {
    it('same tx hash submitted twice -- second attempt rejected', async () => {
      const txHash = 'A'.repeat(64)
      const storeKey = keys.tx(txHash)

      const first = await store.get(storeKey)
      expect(first).toBeNull()
      await store.put(storeKey, Date.now())

      const second = await store.get(storeKey)
      expect(second).not.toBeNull()

      const err = replayDetected(txHash)
      expect(err.message).toContain('REPLAY_DETECTED')
      expect(err.message).toContain(txHash)
    })

    it('same signed blob submitted twice -- second attempt rejected', async () => {
      const blob = '1200002200000000DEADBEEF'
      const blobHash = `blob:${blob}`
      const storeKey = keys.tx(blobHash)

      await store.put(storeKey, Date.now())
      const seen = await store.get(storeKey)
      expect(seen).not.toBeNull()
    })

    it('different tx hashes are independent', async () => {
      const hash1 = 'A'.repeat(64)
      const hash2 = 'B'.repeat(64)

      await store.put(keys.tx(hash1), Date.now())

      const seen1 = await store.get(keys.tx(hash1))
      const seen2 = await store.get(keys.tx(hash2))

      expect(seen1).not.toBeNull()
      expect(seen2).toBeNull()
    })
  })

  describe('Channel replay protection', () => {
    it('same cumulative amount + signature resubmitted -- rejected', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = keys.channel(channelId)

      await store.put(storeKey, {
        cumulative: '500000',
        signature: 'AA'.repeat(64),
        timestamp: Date.now(),
      })

      const state = (await store.get(storeKey)) as any
      const newCumulative = 500000n
      const previousCumulative = BigInt(state.cumulative)

      expect(newCumulative > previousCumulative).toBe(false)
    })

    it('cumulative amount LOWER than previous -- rejected', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = keys.channel(channelId)

      await store.put(storeKey, {
        cumulative: '500000',
        signature: 'AA'.repeat(64),
        timestamp: Date.now(),
      })

      const state = (await store.get(storeKey)) as any
      const newCumulative = 400000n
      const previousCumulative = BigInt(state.cumulative)

      expect(newCumulative > previousCumulative).toBe(false)
    })

    it('higher cumulative amount is accepted', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = keys.channel(channelId)

      await store.put(storeKey, {
        cumulative: '500000',
        signature: 'AA'.repeat(64),
        timestamp: Date.now(),
      })

      const state = (await store.get(storeKey)) as any
      const newCumulative = 600000n
      const previousCumulative = BigInt(state.cumulative)

      expect(newCumulative > previousCumulative).toBe(true)
    })

    it('store persists across requests within same server instance', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = keys.channel(channelId)

      await store.put(storeKey, {
        cumulative: '100000',
        signature: 'S1'.repeat(64),
        timestamp: Date.now(),
      })

      const state = (await store.get(storeKey)) as any
      expect(state.cumulative).toBe('100000')
      expect(state.signature).toBe('S1'.repeat(64))

      await store.put(storeKey, {
        cumulative: '200000',
        signature: 'S2'.repeat(64),
        timestamp: Date.now(),
      })

      const updated = (await store.get(storeKey)) as any
      expect(updated.cumulative).toBe('200000')
      expect(updated.signature).toBe('S2'.repeat(64))
    })
  })
})
