/**
 * Durable replay store backed by DynamoDB.
 *
 * Same reasoning as the SQL adapter: the replay store is authoritative, so it
 * needs durability and conditional writes. DynamoDB expresses the conditional
 * write as a `ConditionExpression` rather than a `WHERE` clause, but the shape is
 * the same optimistic version compare.
 *
 * No AWS SDK dependency. The caller injects three narrow operations, each a
 * handful of lines over `DynamoDBDocumentClient`, so the SDK keeps its
 * dependency surface and the consumer keeps control of credentials, region,
 * retries and tracing. The example below is the whole implementation.
 *
 * @example
 * ```ts
 * import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
 * import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
 * import { Store } from 'mppx/server'
 * import { dynamodbStore } from 'xrpl-mpp-sdk/server'
 *
 * const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
 * const TableName = 'mpp-replay-store'
 *
 * const store = Store.from(dynamodbStore({
 *   async get(key) {
 *     const { Item } = await doc.send(new GetCommand({ TableName, Key: { pk: key } }))
 *     return Item ? { value: Item.value, version: Number(Item.version) } : null
 *   },
 *   async putIfVersion(key, value, expectedVersion) {
 *     try {
 *       await doc.send(new PutCommand({
 *         TableName,
 *         Item: { pk: key, value, version: (expectedVersion ?? 0) + 1 },
 *         ...(expectedVersion === null
 *           ? { ConditionExpression: 'attribute_not_exists(pk)' }
 *           : { ConditionExpression: 'version = :v',
 *               ExpressionAttributeValues: { ':v': expectedVersion } }),
 *       }))
 *       return true
 *     } catch (err) {
 *       if ((err as Error).name === 'ConditionalCheckFailedException') return false
 *       throw err
 *     }
 *   },
 *   async deleteIfVersion(key, expectedVersion) {
 *     try {
 *       await doc.send(new DeleteCommand({
 *         TableName, Key: { pk: key },
 *         ConditionExpression: 'version = :v',
 *         ExpressionAttributeValues: { ':v': expectedVersion },
 *       }))
 *       return true
 *     } catch (err) {
 *       if ((err as Error).name === 'ConditionalCheckFailedException') return false
 *       throw err
 *     }
 *   },
 * }))
 * ```
 *
 * Table: partition key `pk` (string), no sort key. Enable point-in-time recovery,
 * and if you set a TTL attribute point it at nothing the SDK writes -- retention
 * is enforced on read, and a TTL shorter than the challenge window would reopen
 * a replay window rather than just reclaiming space.
 */

import type { Store } from 'mppx'

/** The three conditional operations the adapter needs. */
export type DynamoParameters = {
  /** Read an item, or `null` when absent. */
  get: (key: string) => Promise<{ value: unknown; version: number } | null>
  /**
   * Write conditionally. `expectedVersion` is `null` for a create, which must
   * use `attribute_not_exists`. Return `false` on a condition failure rather
   * than throwing, so the adapter can retry.
   */
  putIfVersion: (key: string, value: unknown, expectedVersion: number | null) => Promise<boolean>
  /** Delete conditionally. Return `false` on a condition failure. */
  deleteIfVersion: (key: string, expectedVersion: number) => Promise<boolean>
}

export type DynamoStoreOptions = {
  /** Attempts before giving up on contention. @default 5 */
  maxRetries?: number
}

/** Build the `{get, put, delete, update}` primitive that `Store.from()` wraps. */
export function dynamodbStore(
  client: DynamoParameters,
  options: DynamoStoreOptions = {},
): Store.AtomicStore {
  const maxRetries = options.maxRetries ?? 5

  return {
    async get(key: string) {
      const item = await client.get(key)
      return (item ? item.value : null) as never
    },

    async put(key: string, value: unknown) {
      // Unconditional last-write-wins. Retries on contention so a concurrent
      // writer bumping the version does not surface as a failed put.
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const existing = await client.get(key)
        const ok = await client.putIfVersion(key, value, existing ? existing.version : null)
        if (ok) return
      }
      throw new Error(`[xrpl-mpp-sdk] dynamodbStore could not write key ${key}: write contention.`)
    },

    async delete(key: string) {
      const existing = await client.get(key)
      if (!existing) return
      await client.deleteIfVersion(key, existing.version)
    },

    async update<result>(
      key: string,
      fn: (current: unknown | null) => Store.Change<unknown, result>,
    ): Promise<result> {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const existing = await client.get(key)
        const change = fn(existing ? existing.value : null)

        if (change.op === 'noop') return change.result

        if (change.op === 'delete') {
          if (!existing) return change.result
          if (await client.deleteIfVersion(key, existing.version)) return change.result
          continue
        }

        const ok = await client.putIfVersion(key, change.value, existing ? existing.version : null)
        if (ok) return change.result
        // Condition failed: another writer got there first. Re-read and
        // re-decide rather than forcing this caller's value through.
      }

      throw new Error(
        `[xrpl-mpp-sdk] dynamodbStore could not settle key ${key} after ${maxRetries} attempts. ` +
          'That means sustained write contention on a single replay key, which normally ' +
          'indicates a retry storm rather than legitimate traffic.',
      )
    },
  }
}
