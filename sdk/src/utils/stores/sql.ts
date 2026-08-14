/**
 * Durable replay store backed by SQL, targeting Postgres.
 *
 * The replay store is the authoritative record that prevents double-spend, so it
 * needs durability and single-statement conditional writes. Postgres gives both;
 * `Store.memory()` gives neither beyond one process.
 *
 * No driver dependency: the caller injects a `query` function, which is
 * signature-compatible with `pg`'s `Client.query` / `Pool.query`, postgres.js,
 * and the Neon and Vercel serverless drivers. That keeps the SDK's dependency
 * surface at mppx, xrpl and zod, and lets a consumer reuse a pool they already
 * have rather than opening a second one.
 *
 * Atomicity comes from an optimistic version column rather than a transaction,
 * so it works on a pooled or serverless connection with no session state:
 *
 * - insert is `ON CONFLICT DO NOTHING`, so a concurrent insert loses
 * - update is `WHERE version = $expected`, so a concurrent update loses
 * - a loser re-reads and re-runs the callback, which is why mppx requires that
 *   callback to be synchronous and free of side effects
 */

import type { Store } from 'mppx'

/** Minimal query surface. `pg`'s `Pool.query` satisfies this as-is. */
export type SqlQuery = (
  sql: string,
  params: readonly unknown[],
) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>

export type SqlStoreOptions = {
  /** Table holding the replay records. @default 'mpp_replay_store' */
  table?: string
  /**
   * Attempts before giving up on contention. Each retry means another
   * transaction won the race, which is progress rather than failure.
   * @default 5
   */
  maxRetries?: number
}

/**
 * DDL for the backing table.
 *
 * `value` is jsonb so records stay inspectable in situ, which matters when
 * reconciling a disputed payment. `expires_at` is written by the SDK's own
 * retention logic; the partial index exists so a periodic reclaim job can find
 * lapsed rows cheaply. Nothing depends on that job running: expiry is enforced
 * on read.
 */
export function sqlSchema(table = 'mpp_replay_store'): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  version    bigint NOT NULL DEFAULT 1,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS ${table}_expires_at_idx
  ON ${table} (expires_at) WHERE expires_at IS NOT NULL;`
}

/**
 * Build the `{get, put, delete, update}` primitive that `Store.from()` wraps.
 *
 * Pass the result to mppx's `Store.from()`:
 *
 * @example
 * ```ts
 * import { Store } from 'mppx/server'
 * import { sqlStore, sqlSchema } from 'xrpl-mpp-sdk/server'
 * import { Pool } from 'pg'
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * await pool.query(sqlSchema())
 *
 * const store = Store.from(sqlStore((sql, params) => pool.query(sql, [...params])))
 *
 * charge({ recipient: 'r...', store, storeDurability: 'shared' })
 * ```
 */
export function sqlStore(query: SqlQuery, options: SqlStoreOptions = {}): Store.AtomicStore {
  const table = options.table ?? 'mpp_replay_store'
  const maxRetries = options.maxRetries ?? 5

  async function read(key: string): Promise<{ value: unknown; version: bigint } | null> {
    const { rows } = await query(`SELECT value, version FROM ${table} WHERE key = $1`, [key])
    const row = rows[0]
    if (!row) return null
    return { value: row.value, version: BigInt(row.version as string | number) }
  }

  return {
    async get(key: string) {
      const row = await read(key)
      // `as never` satisfies the generic `itemMap[key]` in mppx's StoreActions;
      // the declared return type above is what callers actually see.
      return (row ? row.value : null) as never
    },

    async put(key: string, value: unknown) {
      // Unconditional upsert. Only used for records where last-write-wins is
      // correct, such as marking an already-claimed hash confirmed.
      await query(
        `INSERT INTO ${table} (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, version = ${table}.version + 1`,
        [key, JSON.stringify(value)],
      )
    },

    async delete(key: string) {
      await query(`DELETE FROM ${table} WHERE key = $1`, [key])
    },

    async update<result>(
      key: string,
      fn: (current: unknown | null) => Store.Change<unknown, result>,
    ): Promise<result> {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const existing = await read(key)
        const change = fn(existing ? existing.value : null)

        if (change.op === 'noop') return change.result

        if (change.op === 'delete') {
          if (!existing) return change.result
          const { rowCount } = await query(`DELETE FROM ${table} WHERE key = $1 AND version = $2`, [
            key,
            existing.version.toString(),
          ])
          if (rowCount) return change.result
          continue
        }

        const payload = JSON.stringify(change.value)
        if (existing) {
          const { rowCount } = await query(
            `UPDATE ${table} SET value = $2::jsonb, version = version + 1
             WHERE key = $1 AND version = $3`,
            [key, payload, existing.version.toString()],
          )
          if (rowCount) return change.result
        } else {
          const { rowCount } = await query(
            `INSERT INTO ${table} (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO NOTHING`,
            [key, payload],
          )
          if (rowCount) return change.result
        }
        // Lost the race. Re-read and re-decide, which is the whole point of
        // running the callback again rather than forcing the caller's value.
      }

      throw new Error(
        `[xrpl-mpp-sdk] sqlStore could not settle key ${key} after ${maxRetries} attempts. ` +
          'That means sustained write contention on a single replay key, which normally ' +
          'indicates a retry storm rather than legitimate traffic.',
      )
    },
  }
}

/**
 * Delete rows whose retention has lapsed.
 *
 * Purely reclamation. Expiry is enforced on read inside `claimKey`, so
 * correctness never depends on this having run -- a row left behind is wasted
 * space, not a replay window. Call it from a cron if the table's growth matters.
 */
export async function sqlReclaim(query: SqlQuery, options: SqlStoreOptions = {}): Promise<number> {
  const table = options.table ?? 'mpp_replay_store'
  const { rowCount } = await query(
    `DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at < now()`,
    [],
  )
  return rowCount ?? 0
}
