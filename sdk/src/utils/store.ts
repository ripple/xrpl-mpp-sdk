/**
 * Replay-store helpers built on mppx's atomic store contract.
 *
 * Replay protection is the core financial control: charge single-use is keyed
 * on the settled transaction hash, channel single-use on a strictly monotonic
 * cumulative amount. A `get` followed by a `put` is a time-of-check /
 * time-of-use race -- two concurrent verifies can both pass the "not seen"
 * check before either writes. Within one process a promise lock hides that,
 * but across replicas it is a double-spend.
 *
 * Every helper here routes through {@link Store.AtomicStore.update}, whose
 * read-modify-write is atomic in the backing store (a Lua script on Redis, a
 * conditional expression on DynamoDB, `ON CONFLICT` on Postgres). The callback
 * may be replayed by the implementation, so it must stay synchronous and free
 * of side effects -- all network I/O belongs outside.
 */

import type { Store } from 'mppx'
import { warnOnce } from './warn.js'

/**
 * Store contract required for replay protection.
 *
 * Narrower than {@link Store.Store}: the atomic `update` is mandatory, so the
 * type system rejects a backend that cannot do compare-and-set.
 */
export type ReplayStore = Store.AtomicStore

/**
 * Operator attestation about how the configured store is shared.
 *
 * - `shared` -- durable and visible to every process serving this recipient
 *   (Postgres, DynamoDB, or an equivalent with atomic conditional writes).
 * - `process-local` -- in-process only (`Store.memory()`). Safe for a single
 *   instance and for development; a second replica means replay state is not
 *   shared and settled value can be redeemed twice.
 *
 * There is no way to introspect this: the mppx store interface is opaque and a
 * `Map`-backed store is structurally identical to a Postgres-backed one. So the
 * declaration is explicit, and production refuses to start without it.
 */
export type StoreDurability = 'shared' | 'process-local'

/** True when this process looks like a production deployment. */
function isProductionLike(network: string): boolean {
  return network === 'mainnet' || process.env.NODE_ENV === 'production'
}

/**
 * Reject a store that cannot perform atomic compare-and-set.
 *
 * `Store.memory()`, `Store.redis()`, `Store.upstash()` and
 * `Store.cloudflare()` all return an `AtomicStore`, so this only fires for a
 * hand-rolled `Store.from()` implementation that omitted `update`.
 */
export function assertAtomicStore(
  store: Store.Store,
  context: string,
): asserts store is ReplayStore {
  if (typeof (store as Partial<ReplayStore>).update !== 'function') {
    throw new Error(
      `[xrpl-mpp-sdk] ${context} requires a store with atomic compare-and-set. ` +
        'The supplied store has no update() method, so replay protection would be ' +
        'a get-then-put race. Use Store.memory() for development, or a durable ' +
        'backend with single-statement conditional writes (Postgres ' +
        'INSERT .. ON CONFLICT DO NOTHING, DynamoDB attribute_not_exists) via Store.from().',
    )
  }
}

/**
 * Refuse to run in production against a store that was not declared shared.
 *
 * Non-production deployments get a single warning rather than a throw, so
 * local development and tests keep working with `Store.memory()`.
 */
export function assertStoreDurability(parameters: {
  durability: StoreDurability | undefined
  network: string
  context: string
}): void {
  const { durability, network, context } = parameters
  if (durability === 'shared') return

  const detail =
    `[xrpl-mpp-sdk] ${context} needs a shared, durable replay store. ` +
    "Pass storeDurability: 'shared' once the store is backed by a durable backend " +
    'visible to every replica, or ' +
    "storeDurability: 'process-local' to acknowledge single-instance-only operation. " +
    'A process-local store does not share settled-hash or channel high-water state ' +
    'across processes, so a payment accepted by one replica is unknown to the next.'

  if (isProductionLike(network)) {
    if (durability === 'process-local') {
      throw new Error(
        `[xrpl-mpp-sdk] storeDurability: 'process-local' is not permitted on ${network}. ` +
          'Settled value would be redeemable once per replica. Use a durable shared store.',
      )
    }
    throw new Error(detail)
  }

  if (durability === undefined) warnOnce(`store-durability:${context}`, detail)
}

/** A claim record, with the retention deadline the SDK enforces on read. */
type ClaimRecord = Record<string, unknown> & { expiresAt?: number }

/**
 * Atomically claim `key` if and only if it is unset or its retention has
 * lapsed.
 *
 * Returns `true` for the caller that wrote the value and `false` for every
 * other caller, including concurrent ones in other processes. This is the
 * single-use primitive behind challenge-id and transaction-hash replay
 * protection.
 *
 * **Expiry is enforced here rather than by the backend.** mppx's store
 * interface has no TTL parameter, so the deadline is written into the value and
 * checked inside the same compare-and-set: an expired record is overwritten
 * rather than deleted, which keeps the whole operation atomic, needs no
 * `delete` on the replay path, and reuses the key instead of accumulating a
 * second one. Backend-level TTL remains worth configuring, but only to reclaim
 * space -- correctness does not depend on it.
 *
 * Retention must exceed the window in which the credential could still be
 * presented, or the claim stops being single-use. Callers derive it from the
 * challenge lifetime; see `resolveReplayRetention`.
 */
export async function claimKey(
  store: ReplayStore,
  key: string,
  value: Record<string, unknown>,
  retentionMs?: number,
): Promise<boolean> {
  const now = Date.now()
  const record: ClaimRecord = {
    ...value,
    ...(retentionMs !== undefined && retentionMs > 0 ? { expiresAt: now + retentionMs } : {}),
  }

  return await store.update(key, (current): Store.Change<unknown, boolean> => {
    if (current === null || current === undefined) {
      return { op: 'set', value: record, result: true }
    }
    const existing = current as ClaimRecord
    // A lapsed record carries no replay risk: the credential that created it can
    // no longer be presented, because its challenge is past `maxChallengeAge`.
    if (typeof existing.expiresAt === 'number' && existing.expiresAt <= now) {
      return { op: 'set', value: record, result: true }
    }
    return { op: 'noop', result: false }
  })
}

/**
 * Clock skew between the issuing and the verifying process, plus room for a
 * verification that overruns its poll budget slightly.
 */
const RETENTION_SKEW_MS = 60_000

/**
 * How long a replay claim must be retained for this specific credential.
 *
 * Derived from the challenge's own `expires`, which is the only authenticated
 * statement about how long the credential can still be presented: it is covered
 * by the challenge HMAC, so a client cannot extend it, and mppx rejects a
 * credential past it before this SDK's `verify` is reached.
 *
 * Retention therefore has to outlast the remaining `expires` window plus the
 * time verification itself may take. Anything shorter would let a claim lapse
 * while its credential is still acceptable, which is the definition of a replay
 * window.
 *
 * Returns `undefined`, meaning retain forever, when there is no usable
 * `expires`. That is the fail-safe direction: with no authenticated bound on the
 * presentable window, no finite retention can be justified.
 *
 * A bounded value is only sound at all because every payment is bound to one
 * challenge. Without that binding any prior payment satisfied any challenge, so
 * a transaction hash stayed replayable for as long as it existed on the ledger.
 */
export function replayRetentionFor(parameters: {
  expiresIso: string | undefined
  pollTimeout: number
  nowMs?: number
}): number | undefined {
  const { expiresIso, pollTimeout } = parameters
  if (!expiresIso) return undefined

  const expiresMs = Date.parse(expiresIso)
  if (Number.isNaN(expiresMs)) return undefined

  const now = parameters.nowMs ?? Date.now()
  // Clamp at zero rather than going negative: an already-expired challenge is
  // rejected elsewhere, and a negative retention would mark the claim as
  // instantly lapsed.
  const remaining = Math.max(0, expiresMs - now)
  return remaining + pollTimeout + RETENTION_SKEW_MS
}

/** Persisted channel high-water state. */
export type ChannelHighWater = {
  cumulative: string
  signature: string
  timestamp: number
}

/** Outcome of an attempted high-water advance. */
export type HighWaterOutcome =
  | { status: 'advanced'; previous: bigint }
  | { status: 'replay'; previous: bigint }
  | { status: 'regressed'; previous: bigint }
  | { status: 'short'; previous: bigint }

/**
 * Atomically advance a channel's cumulative high-water mark.
 *
 * The comparison and the write happen in one conditional operation, so two
 * concurrent vouchers cannot both be credited above the same prior mark. The
 * caller decides how to surface each rejection:
 *
 * - `replay` -- cumulative equals the stored mark.
 * - `regressed` -- cumulative is below the stored mark.
 * - `short` -- cumulative advances, but not by the amount the challenge asked for.
 */
export async function advanceHighWater(
  store: ReplayStore,
  key: string,
  parameters: {
    cumulative: bigint
    requested: bigint
    signature: string
    timestamp: number
  },
): Promise<HighWaterOutcome> {
  const { cumulative, requested, signature, timestamp } = parameters

  return await store.update(key, (current): Store.Change<unknown, HighWaterOutcome> => {
    const state = current as ChannelHighWater | null
    // No record means nothing has been credited on this channel yet, so the
    // mark starts at zero. Treating "no record" as "no constraint" is what let a
    // first voucher of one drop satisfy a request for a full XRP: reachable
    // whenever the channel was opened out-of-band via openChannel() and the
    // server only ever sees the voucher path.
    const previous = state ? BigInt(state.cumulative) : 0n

    if (cumulative === previous) return { op: 'noop', result: { status: 'replay', previous } }
    if (cumulative < previous) return { op: 'noop', result: { status: 'regressed', previous } }
    if (requested > 0n && cumulative < previous + requested)
      return { op: 'noop', result: { status: 'short', previous } }

    const value: ChannelHighWater = {
      cumulative: cumulative.toString(),
      signature,
      timestamp,
    }
    return { op: 'set', value, result: { status: 'advanced', previous } }
  })
}
