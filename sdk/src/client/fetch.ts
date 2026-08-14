/**
 * Workaround for an upstream clone hazard in the mppx client (0.8.x, current
 * at 0.8.17).
 *
 * On a 402 the mppx fetch wrapper snapshots the challenge response for its
 * client events by calling `response.clone()`: once when the challenge arrives,
 * and again after the credential has been created. Both snapshots are discarded
 * when nothing is listening.
 *
 * `clone()` on a network response tees the body stream. Collecting a tee'd
 * branch marks the original consumed, so by the time the second snapshot runs
 * the first has already poisoned it and `clone()` throws. That throw lands in
 * the wrapper's own catch, which builds a payment-failed payload by cloning the
 * same response a third time. That throws too, and replaces whatever the real
 * outcome was -- the caller sees "Response.clone: Body has already been
 * consumed" and no trace of the payment.
 *
 * The trigger is garbage collection, not elapsed time. The window between the
 * two clones is the credential-signing step, which on XRPL includes pre-flight
 * ledger lookups, so it is wide and allocation-heavy. In practice this hit
 * roughly half of all charge requests.
 *
 * Two things do not fix it, both measured rather than assumed:
 * - Buffering the body. A memory-backed response is still disturbed by the
 *   discarded clone.
 * - Draining the snapshot from an event listener. A fully-read tee'd branch
 *   still poisons the original when it is collected.
 *
 * What works is making `clone()` non-destructive: hand back a fresh response
 * over a copy of the bytes and leave the original alone, so any number of
 * snapshots are independent.
 *
 * Remove this module and its call sites once mppx guards its snapshot clones.
 */

/** Statuses whose responses mppx snapshots, and so must survive re-cloning. */
const SNAPSHOTTED_STATUS = 402

/**
 * Wrap a fetch so payment challenges survive being snapshotted repeatedly.
 *
 * This is the shape to prefer. It mutates nothing -- pass it to `Mppx.create`
 * as the base fetch, with `polyfill: false` so no global is touched either, and
 * call through the returned client:
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { challengeSafeFetch, charge } from 'xrpl-mpp-sdk/client'
 *
 * const mppx = Mppx.create({
 *   methods: [charge({ wallet, network: 'testnet' })],
 *   fetch: challengeSafeFetch(),
 *   polyfill: false,
 * })
 *
 * const response = await mppx.fetch('https://api.example.com/resource')
 * ```
 *
 * It composes, so a caller who already wraps fetch for proxying, retries or
 * tracing passes theirs in rather than losing it.
 *
 * @param base - Fetch to delegate to. Defaults to the global one.
 */
export function challengeSafeFetch(base: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, init)
    if (response.status !== SNAPSHOTTED_STATUS) return response

    const bytes = await response.arrayBuffer()
    const copy = (): Response => {
      // slice() so each snapshot owns its bytes and reading one cannot affect
      // another.
      const next = new Response(bytes.slice(0), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      })
      Object.defineProperty(next, 'clone', { configurable: true, value: copy })
      // `url` is a getter on the prototype and is otherwise lost, but mppx
      // reads it to resolve where the paid retry should go.
      Object.defineProperty(next, 'url', { configurable: true, value: response.url })
      return next
    }
    return copy()
  }) as typeof fetch
}

/**
 * Install {@link challengeSafeFetch} over the global fetch.
 *
 * For the polyfill style, where `Mppx.create()` replaces `globalThis.fetch` and
 * callers use it bare. Call before `Mppx.create()`, which captures whatever the
 * global is at that moment as its base.
 *
 * Prefer {@link challengeSafeFetch} where you control the call site: this
 * mutates a global, which is visible to every other consumer in the process.
 *
 * @example
 * ```ts
 * const restore = bufferChallengeResponses()
 * Mppx.create({ methods: [charge({ wallet, network: 'testnet' })] })
 *
 * const response = await fetch('https://api.example.com/resource')
 * ```
 *
 * @returns A function restoring the previous `fetch`.
 */
export function bufferChallengeResponses(): () => void {
  const base = globalThis.fetch
  globalThis.fetch = challengeSafeFetch(base)
  return () => {
    globalThis.fetch = base
  }
}
