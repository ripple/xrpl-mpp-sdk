import { Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import {
  advanceHighWater,
  assertAtomicStore,
  assertStoreDurability,
  claimKey,
  type ReplayStore,
} from '../../sdk/src/utils/store.js'

/**
 * A store whose `update` is atomic but genuinely asynchronous: it yields to the
 * event loop before reading, exactly where a real backend would incur a round
 * trip. A get-then-put implementation interleaves across that yield and loses
 * the race; a single conditional operation does not.
 */
function asyncAtomicStore(): ReplayStore & { getCalls: number; putCalls: number } {
  const backing = new Map<string, string>()
  let mutex: Promise<unknown> = Promise.resolve()
  const state = {
    getCalls: 0,
    putCalls: 0,
    async get(key: string) {
      state.getCalls++
      await Promise.resolve()
      const raw = backing.get(key)
      return raw === undefined ? null : JSON.parse(raw)
    },
    async put(key: string, value: unknown) {
      state.putCalls++
      await Promise.resolve()
      backing.set(key, JSON.stringify(value))
    },
    async delete(key: string) {
      backing.delete(key)
    },
    update<result>(key: string, fn: (current: unknown | null) => any): Promise<result> {
      const run = mutex.then(async () => {
        await Promise.resolve()
        const raw = backing.get(key)
        const current = raw === undefined ? null : JSON.parse(raw)
        const change = fn(current)
        if (change.op === 'set') backing.set(key, JSON.stringify(change.value))
        if (change.op === 'delete') backing.delete(key)
        return change.result as result
      })
      mutex = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
  return state as never
}

describe('replay store atomicity', () => {
  describe('claimKey (single-use primitive)', () => {
    it('grants the key to exactly one of many concurrent callers', async () => {
      const store = asyncAtomicStore()
      const key = 'claim-a'

      const results = await Promise.all(
        Array.from({ length: 25 }, () => claimKey(store, key, { startedAt: 1 })),
      )

      expect(results.filter((granted) => granted === true)).toHaveLength(1)
      expect(results.filter((granted) => granted === false)).toHaveLength(24)
    })

    it('loses the race when the same check is written as get-then-put', async () => {
      // Documents the defect being fixed: the previous implementation read,
      // decided, then wrote, so concurrent callers all observed "not seen".
      const store = asyncAtomicStore()
      const key = 'claim-b'

      const getThenPut = async () => {
        const seen = await store.get(key)
        if (seen) return false
        await store.put(key, { startedAt: 1 })
        return true
      }

      const results = await Promise.all(Array.from({ length: 25 }, getThenPut))
      expect(results.filter((granted) => granted === true).length).toBeGreaterThan(1)
    })

    it('keeps distinct keys independent', async () => {
      const store = Store.memory()
      expect(await claimKey(store, 'claim-one', { startedAt: 1 })).toBe(true)
      expect(await claimKey(store, 'claim-two', { startedAt: 1 })).toBe(true)
      expect(await claimKey(store, 'claim-one', { startedAt: 2 })).toBe(false)
    })

    it('does not fall back to get or put', async () => {
      const store = asyncAtomicStore()
      await claimKey(store, 'claim-abc', { usedAt: 'now' })
      expect(store.getCalls).toBe(0)
      expect(store.putCalls).toBe(0)
    })
  })

  describe('advanceHighWater (channel cumulative)', () => {
    const key = 'high-water-c'

    it('advances from an unset mark', async () => {
      const store = Store.memory()
      const outcome = await advanceHighWater(store, key, {
        cumulative: 1000n,
        requested: 0n,
        signature: 'DEAD',
        timestamp: 1,
      })
      expect(outcome).toEqual({ status: 'advanced', previous: 0n })
    })

    it('rejects an equal cumulative as replay', async () => {
      const store = Store.memory()
      const base = { requested: 0n, signature: 'DEAD', timestamp: 1 }
      await advanceHighWater(store, key, { ...base, cumulative: 1000n })

      const outcome = await advanceHighWater(store, key, { ...base, cumulative: 1000n })
      expect(outcome).toEqual({ status: 'replay', previous: 1000n })
    })

    it('rejects a lower cumulative as regression', async () => {
      const store = Store.memory()
      const base = { requested: 0n, signature: 'DEAD', timestamp: 1 }
      await advanceHighWater(store, key, { ...base, cumulative: 1000n })

      const outcome = await advanceHighWater(store, key, { ...base, cumulative: 999n })
      expect(outcome).toEqual({ status: 'regressed', previous: 1000n })
    })

    it('rejects a first voucher that does not cover the requested amount', async () => {
      // Regression: the requested-amount check used to apply only when a prior
      // record existed, so the first voucher on a channel could be any non-zero
      // cumulative. Reachable whenever the channel was opened out-of-band via
      // openChannel() and the server only ever sees the voucher path, which is
      // how the integration tests drive it.
      const store = Store.memory()
      const outcome = await advanceHighWater(store, 'first-voucher', {
        cumulative: 1n,
        requested: 1_000_000n,
        signature: 'DEAD',
        timestamp: 1,
      })
      expect(outcome).toEqual({ status: 'short', previous: 0n })
    })

    it('accepts a first voucher that does cover the requested amount', async () => {
      const store = Store.memory()
      const outcome = await advanceHighWater(store, 'first-voucher-ok', {
        cumulative: 1_000_000n,
        requested: 1_000_000n,
        signature: 'DEAD',
        timestamp: 1,
      })
      expect(outcome).toEqual({ status: 'advanced', previous: 0n })
    })

    it('rejects a zero-value first voucher', async () => {
      const store = Store.memory()
      const outcome = await advanceHighWater(store, 'zero-voucher', {
        cumulative: 0n,
        requested: 0n,
        signature: 'DEAD',
        timestamp: 1,
      })
      expect(outcome).toEqual({ status: 'replay', previous: 0n })
    })

    it('rejects an advance that does not cover the requested amount', async () => {
      const store = Store.memory()
      await advanceHighWater(store, key, {
        cumulative: 1000n,
        requested: 0n,
        signature: 'DEAD',
        timestamp: 1,
      })

      const outcome = await advanceHighWater(store, key, {
        cumulative: 1050n,
        requested: 100n,
        signature: 'BEEF',
        timestamp: 2,
      })
      expect(outcome).toEqual({ status: 'short', previous: 1000n })
    })

    it('credits exactly one of two concurrent vouchers at the same cumulative', async () => {
      const store = asyncAtomicStore()
      const base = { requested: 0n, signature: 'DEAD', timestamp: 1 }

      const outcomes = await Promise.all([
        advanceHighWater(store, key, { ...base, cumulative: 5000n }),
        advanceHighWater(store, key, { ...base, cumulative: 5000n }),
      ])

      expect(outcomes.filter((o) => o.status === 'advanced')).toHaveLength(1)
      expect(outcomes.filter((o) => o.status === 'replay')).toHaveLength(1)
    })

    it('serialises a concurrent burst so the mark never regresses', async () => {
      const store = asyncAtomicStore()
      const burst = [400n, 100n, 300n, 200n, 500n]

      const outcomes = await Promise.all(
        burst.map((cumulative) =>
          advanceHighWater(store, key, {
            cumulative,
            requested: 0n,
            signature: 'DEAD',
            timestamp: 1,
          }),
        ),
      )

      // Whatever the interleaving, the stored mark is the highest accepted
      // value and every accepted advance strictly increased it.
      const advanced = outcomes.filter((o) => o.status === 'advanced')
      expect(advanced.length).toBeGreaterThan(0)
      const stored = (await store.get(key)) as { cumulative: string }
      expect(BigInt(stored.cumulative)).toBe(500n)
      for (const outcome of advanced) {
        expect(outcome.previous).toBeLessThan(500n)
      }
    })
  })

  describe('assertAtomicStore', () => {
    it('accepts every store factory mppx ships', () => {
      expect(() => assertAtomicStore(Store.memory(), 'test')).not.toThrow()
    })

    it('rejects a store without update()', () => {
      const store = { get: async () => null, put: async () => {}, delete: async () => {} }
      expect(() => assertAtomicStore(store as never, 'test')).toThrow('atomic compare-and-set')
    })
  })

  describe('assertStoreDurability', () => {
    it('accepts a store declared shared', () => {
      expect(() =>
        assertStoreDurability({ durability: 'shared', network: 'mainnet', context: 'charge' }),
      ).not.toThrow()
    })

    it('refuses an undeclared store on mainnet', () => {
      expect(() =>
        assertStoreDurability({ durability: undefined, network: 'mainnet', context: 'charge' }),
      ).toThrow('shared, durable replay store')
    })

    it('refuses a process-local store on mainnet', () => {
      expect(() =>
        assertStoreDurability({
          durability: 'process-local',
          network: 'mainnet',
          context: 'charge',
        }),
      ).toThrow('not permitted on mainnet')
    })

    it('refuses an undeclared store when NODE_ENV is production', () => {
      vi.stubEnv('NODE_ENV', 'production')
      expect(() =>
        assertStoreDurability({ durability: undefined, network: 'testnet', context: 'charge' }),
      ).toThrow('shared, durable replay store')
      vi.unstubAllEnvs()
    })

    it('warns rather than throws outside production', () => {
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
      expect(() =>
        assertStoreDurability({
          durability: undefined,
          network: 'testnet',
          context: 'charge-warn',
        }),
      ).not.toThrow()
      warn.mockRestore()
    })

    it('accepts an acknowledged process-local store outside production', () => {
      expect(() =>
        assertStoreDurability({
          durability: 'process-local',
          network: 'devnet',
          context: 'charge',
        }),
      ).not.toThrow()
    })
  })
})
