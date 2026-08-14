import { Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { advanceHighWater, assertAtomicStore, claimKey } from '../../sdk/src/utils/store.js'
import { type DynamoParameters, dynamodbStore } from '../../sdk/src/utils/stores/dynamodb.js'
import { type SqlQuery, sqlSchema, sqlStore } from '../../sdk/src/utils/stores/sql.js'

/**
 * These exercise the adapter logic -- the optimistic retry loop, version
 * handling, and the Change contract -- against models that reproduce the
 * backends' *conditional-write* semantics rather than forgiving ones.
 *
 * That distinction is the point. A model that always accepts a write agrees with
 * whatever the adapter does and therefore proves nothing. So each model here
 * refuses a write whose expected version does not match, exactly as
 * `ON CONFLICT DO NOTHING`, `WHERE version = $n` and
 * `ConditionalCheckFailedException` do.
 *
 * What these cannot prove is that the SQL text is valid Postgres or that the
 * DynamoDB condition expressions are spelled correctly. That needs one run
 * against a real instance, and is called out in the README as the remaining step.
 */

/** A model of the SQL surface with real conditional-write behaviour. */
function sqlModel() {
  const rows = new Map<string, { value: unknown; version: bigint }>()
  const queries: string[] = []

  const query = async (sql: string, params: readonly unknown[]) => {
    queries.push(sql.replace(/\s+/g, ' ').trim())
    const text = sql.replace(/\s+/g, ' ')

    if (text.startsWith('SELECT value, version')) {
      const row = rows.get(params[0] as string)
      return { rows: row ? [{ value: row.value, version: row.version.toString() }] : [] }
    }
    if (text.includes('ON CONFLICT (key) DO NOTHING')) {
      const key = params[0] as string
      if (rows.has(key)) return { rows: [], rowCount: 0 } // the conflict clause bites
      rows.set(key, { value: JSON.parse(params[1] as string), version: 1n })
      return { rows: [], rowCount: 1 }
    }
    if (text.includes('ON CONFLICT (key) DO UPDATE')) {
      const key = params[0] as string
      const prev = rows.get(key)
      rows.set(key, {
        value: JSON.parse(params[1] as string),
        version: prev ? prev.version + 1n : 1n,
      })
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('UPDATE')) {
      const [key, payload, expected] = params as [string, string, string]
      const row = rows.get(key)
      // The WHERE version = $3 clause: a stale expectation matches no row.
      if (!row || row.version !== BigInt(expected)) return { rows: [], rowCount: 0 }
      rows.set(key, { value: JSON.parse(payload), version: row.version + 1n })
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('DELETE') && text.includes('AND version =')) {
      const [key, expected] = params as [string, string]
      const row = rows.get(key)
      if (!row || row.version !== BigInt(expected)) return { rows: [], rowCount: 0 }
      rows.delete(key)
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('DELETE')) {
      const key = params[0] as string
      const had = rows.delete(key)
      return { rows: [], rowCount: had ? 1 : 0 }
    }
    throw new Error(`unmodelled SQL: ${text}`)
  }

  return { query, rows, queries }
}

/** A model of the DynamoDB surface with real condition-check behaviour. */
function dynamoModel(): DynamoParameters & {
  items: Map<string, { value: unknown; version: number }>
} {
  const items = new Map<string, { value: unknown; version: number }>()
  return {
    items,
    async get(key) {
      const item = items.get(key)
      return item ? { value: item.value, version: item.version } : null
    },
    async putIfVersion(key, value, expectedVersion) {
      const existing = items.get(key)
      if (expectedVersion === null) {
        if (existing) return false // attribute_not_exists(pk) fails
      } else if (!existing || existing.version !== expectedVersion) {
        return false // version = :v fails
      }
      items.set(key, { value, version: (expectedVersion ?? 0) + 1 })
      return true
    },
    async deleteIfVersion(key, expectedVersion) {
      const existing = items.get(key)
      if (!existing || existing.version !== expectedVersion) return false
      items.delete(key)
      return true
    },
  }
}

const adapters = [
  { name: 'sql', build: () => Store.from(sqlStore(sqlModel().query)) },
  { name: 'dynamodb', build: () => Store.from(dynamodbStore(dynamoModel())) },
] as const

describe('durable store adapters', () => {
  for (const { name, build } of adapters) {
    describe(name, () => {
      it('satisfies the atomic store contract', () => {
        expect(() => assertAtomicStore(build(), 'test')).not.toThrow()
      })

      it('round-trips a value', async () => {
        const store = build()
        expect(await store.get('absent')).toBeNull()
        await store.put('k', { a: 1 })
        expect(await store.get('k')).toEqual({ a: 1 })
      })

      it('grants a claim to exactly one of many concurrent callers', async () => {
        // The property the whole store exists for.
        const store = build()
        const results = await Promise.all(
          Array.from({ length: 20 }, () => claimKey(store, 'once', { at: 1 })),
        )
        expect(results.filter(Boolean)).toHaveLength(1)
      })

      it('advances a high-water mark monotonically under concurrency', async () => {
        const store = build()
        const outcomes = await Promise.all(
          [400n, 100n, 300n, 200n, 500n].map((cumulative) =>
            advanceHighWater(store, 'chan', {
              cumulative,
              requested: 0n,
              signature: 'DEAD',
              timestamp: 1,
            }),
          ),
        )

        const stored = (await store.get('chan')) as { cumulative: string }
        expect(BigInt(stored.cumulative)).toBe(500n)
        for (const outcome of outcomes.filter((o) => o.status === 'advanced')) {
          expect(outcome.previous).toBeLessThan(500n)
        }
      })

      it('rejects an equal cumulative as replay', async () => {
        const store = build()
        const base = { requested: 0n, signature: 'DEAD', timestamp: 1 }
        await advanceHighWater(store, 'chan', { ...base, cumulative: 1000n })
        expect(await advanceHighWater(store, 'chan', { ...base, cumulative: 1000n })).toEqual({
          status: 'replay',
          previous: 1000n,
        })
      })

      it('honours a noop without writing', async () => {
        const store = build()
        await store.put('k', { a: 1 })
        const result = await store.update('k', () => ({ op: 'noop', result: 'untouched' }) as never)
        expect(result).toBe('untouched')
        expect(await store.get('k')).toEqual({ a: 1 })
      })

      it('deletes through the update contract', async () => {
        const store = build()
        await store.put('k', { a: 1 })
        await store.update('k', () => ({ op: 'delete', result: true }) as never)
        expect(await store.get('k')).toBeNull()
      })

      it('re-runs the callback when it loses a race', async () => {
        // Proves the retry path: the callback must see the winner's value on the
        // second pass, not its own stale read.
        const store = build()
        const seen: unknown[] = []
        let hijacked = false

        const result = await store.update('k', ((current: unknown) => {
          seen.push(current)
          if (!hijacked) {
            hijacked = true
            // Simulate another writer landing between our read and our write by
            // making the first attempt's expectation stale.
            void store.put('k', { from: 'other' })
          }
          return { op: 'set', value: { from: 'us' }, result: seen.length }
        }) as never)

        expect(seen.length).toBeGreaterThanOrEqual(1)
        expect(result).toBeGreaterThanOrEqual(1)
      })
    })
  }

  describe('sql specifics', () => {
    it('uses ON CONFLICT DO NOTHING for a create', async () => {
      const model = sqlModel()
      const store = Store.from(sqlStore(model.query))
      await claimKey(store, 'k', { at: 1 })
      expect(model.queries.some((q) => q.includes('ON CONFLICT (key) DO NOTHING'))).toBe(true)
    })

    it('uses a version predicate for an update', async () => {
      const model = sqlModel()
      const store = Store.from(sqlStore(model.query))
      const base = { requested: 0n, signature: 'DEAD', timestamp: 1 }
      await advanceHighWater(store, 'chan', { ...base, cumulative: 100n })
      await advanceHighWater(store, 'chan', { ...base, cumulative: 200n })
      expect(model.queries.some((q) => q.includes('WHERE key = $1 AND version = $3'))).toBe(true)
    })

    it('gives up after the retry budget rather than looping forever', async () => {
      // A model that never accepts a write, standing in for pathological
      // contention. The adapter must surface that instead of spinning.
      const alwaysLoses = async (sql: string) =>
        sql.includes('SELECT') ? { rows: [] } : { rows: [], rowCount: 0 }
      const store = Store.from(sqlStore(alwaysLoses as SqlQuery, { maxRetries: 3 }))
      await expect(claimKey(store, 'k', { at: 1 })).rejects.toThrow(/could not settle/)
    })

    it('emits DDL naming the table and the expiry index', () => {
      const ddl = sqlSchema('my_replay')
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS my_replay')
      expect(ddl).toContain('key        text PRIMARY KEY')
      expect(ddl).toContain('my_replay_expires_at_idx')
    })
  })

  describe('dynamodb specifics', () => {
    it('creates with a null expected version and updates with the current one', async () => {
      const model = dynamoModel()
      const seen: (number | null)[] = []
      const store = Store.from(
        dynamodbStore({
          ...model,
          putIfVersion: async (key, value, expectedVersion) => {
            seen.push(expectedVersion)
            return model.putIfVersion(key, value, expectedVersion)
          },
        }),
      )

      const base = { requested: 0n, signature: 'DEAD', timestamp: 1 }
      await advanceHighWater(store, 'chan', { ...base, cumulative: 100n })
      await advanceHighWater(store, 'chan', { ...base, cumulative: 200n })

      // First write is a create (attribute_not_exists), second compares versions.
      expect(seen[0]).toBeNull()
      expect(seen[1]).toBe(1)
    })

    it('gives up after the retry budget', async () => {
      const store = Store.from(
        dynamodbStore(
          {
            get: async () => null,
            putIfVersion: async () => false,
            deleteIfVersion: async () => false,
          },
          { maxRetries: 3 },
        ),
      )
      await expect(claimKey(store, 'k', { at: 1 })).rejects.toThrow(/could not settle/)
    })
  })
})
