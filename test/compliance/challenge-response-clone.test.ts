import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { bufferChallengeResponses, challengeSafeFetch } from '../../sdk/src/client/fetch.js'

/**
 * The mppx client snapshots the 402 response by cloning it, twice, with the
 * credential-signing round trip in between. The second clone throws once the
 * first has disturbed the body, and the throw is then masked by a third clone in
 * mppx's own error path -- so a working payment surfaces as
 * "Response.clone: Body has already been consumed".
 *
 * The trigger is garbage collection, not elapsed time: `clone()` tees the body,
 * mppx never reads the tee'd branch, and collecting that branch marks the
 * original consumed. That is why it correlated with signing, which is seconds of
 * allocation-heavy ledger work, and why it hit roughly half of all charge
 * requests rather than all or none.
 *
 * Reproducing it therefore needs a real 402 over loopback plus an explicit
 * collection. A response built in memory does not reproduce it, and neither does
 * one left uncollected.
 *
 * Whether collection disturbs the original is undici's behaviour rather than
 * ours, and it varies by runtime: it reproduces on Node 23 and does not on Node
 * 20. So the three tests that demonstrate the hazard are gated on a probe that
 * measures the running environment. Asserting it outright would make the suite
 * demand that someone else's bug be present, which is not a property this SDK
 * should require.
 *
 * The tests that matter are ungated: they pin our wrapper's contract, which must
 * hold whether or not the platform exhibits the hazard.
 */

const CHALLENGE_BODY = JSON.stringify({ status: 402, type: 'https://paymentauth.org/problems/x' })

/** Present only under `--expose-gc`, which vitest.config.ts passes. */
const collect = (globalThis as { gc?: () => void }).gc

const restores: Array<() => void> = []

// Set up at module scope rather than in beforeAll: vitest evaluates `skipIf` when
// a test is defined, not when it runs, so the probe below has to have finished
// before the describe blocks are registered.
const server: Server = createServer((_request, response) => {
  response.writeHead(402, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/problem+json',
    'WWW-Authenticate': 'Payment realm="test"',
  })
  response.end(CHALLENGE_BODY)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (typeof address === 'string' || address === null) throw new Error('no port')
const origin = `http://127.0.0.1:${address.port}`

/**
 * Whether this runtime's `clone()` really does poison the original once the
 * unread branch is collected. Measured, because it is undici's behaviour rather
 * than something this SDK controls or depends on.
 */
const hazardReproduces = await (async () => {
  if (!collect) return false
  const probe = await fetch(`${origin}/resource`)
  probe.clone()
  collect()
  await new Promise((resolve) => setTimeout(resolve, 10))
  collect()
  try {
    probe.clone()
    return false
  } catch {
    return true
  }
})()

afterAll(() => {
  server.close()
})

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

function install() {
  restores.push(bufferChallengeResponses())
}

/** clone -> drop -> collect -> clone, which is what mppx does around signing. */
async function cloneAcrossCollection(response: Response) {
  response.clone()
  collect?.()
  await new Promise((resolve) => setTimeout(resolve, 10))
  collect?.()
  response.clone()
  response.clone()
}

describe('bufferChallengeResponses', () => {
  it.skipIf(!hazardReproduces)(
    'a raw 402 really does break, so the guard below is load-bearing',
    async () => {
      const response = await fetch(`${origin}/resource`)
      await expect(cloneAcrossCollection(response)).rejects.toThrow(/already been consumed/)
    },
  )

  it('survives the same sequence once installed', async () => {
    install()
    const response = await fetch(`${origin}/resource`)
    await expect(cloneAcrossCollection(response)).resolves.toBeUndefined()
    expect(await response.json()).toEqual({
      status: 402,
      type: 'https://paymentauth.org/problems/x',
    })
  })

  it('gives each snapshot an independent body', async () => {
    install()
    const response = await fetch(`${origin}/resource`)
    const first = response.clone()
    const second = response.clone()

    expect(await first.text()).toBe(CHALLENGE_BODY)
    expect(await second.text()).toBe(CHALLENGE_BODY)
    expect(await response.text()).toBe(CHALLENGE_BODY)
  })

  it('preserves status, headers and url', async () => {
    install()
    const response = await fetch(`${origin}/resource`)

    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toBe('Payment realm="test"')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    // mppx reads `url` to resolve where the paid retry goes, and it is a
    // prototype getter that a plain reconstruction would drop.
    expect(response.url).toBe(`${origin}/resource`)
    expect(response.clone().url).toBe(`${origin}/resource`)
  })

  it('leaves every other status untouched', async () => {
    const plain = createServer((_request, response) => {
      response.writeHead(200)
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    const address = plain.address()
    if (typeof address === 'string' || address === null) throw new Error('no port')

    install()
    const response = await fetch(`http://127.0.0.1:${address.port}/`)

    // Buffering every response would mean holding every body in memory, and
    // nothing but the challenge is ever re-cloned.
    expect(await response.text()).toBe('{"ok":true}')
    expect(Object.hasOwn(response, 'clone')).toBe(false)
    plain.close()
  })

  it('restores the previous fetch', () => {
    const before = globalThis.fetch
    const restore = bufferChallengeResponses()
    expect(globalThis.fetch).not.toBe(before)
    restore()
    expect(globalThis.fetch).toBe(before)
  })

  describe('near misses, kept because both look like fixes', () => {
    it.skipIf(!hazardReproduces)('buffering the body alone does not help', async () => {
      // What the first attempt did: read the body, hand back a plain Response.
      // Still disturbed by the discarded clone, because clone() still tees.
      const raw = await fetch(`${origin}/resource`)
      const buffered = new Response(await raw.arrayBuffer(), { status: 402 })
      await expect(cloneAcrossCollection(buffered)).rejects.toThrow(/already been consumed/)
    })

    it.skipIf(!hazardReproduces)('draining the snapshot does not help either', async () => {
      // What a challenge.received listener could plausibly do. A fully-read
      // tee'd branch still poisons the original when it is collected, which is
      // why the fix cannot live in an event handler.
      const response = await fetch(`${origin}/resource`)
      await response.clone().arrayBuffer()
      collect?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
      collect?.()
      expect(() => response.clone()).toThrow(/already been consumed/)
    })
  })

  describe('challengeSafeFetch, the scoped form', () => {
    it('survives the sequence without touching any global', async () => {
      const before = globalThis.fetch
      const safe = challengeSafeFetch()

      const response = await safe(`${origin}/resource`)
      await expect(cloneAcrossCollection(response)).resolves.toBeUndefined()

      // The point of this form: nothing else in the process is affected.
      expect(globalThis.fetch).toBe(before)
    })

    it('composes with a caller-supplied fetch rather than replacing it', async () => {
      // A consumer who already wraps fetch for tracing or proxying keeps theirs.
      let calls = 0
      const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++
        return await globalThis.fetch(input, init)
      }) as typeof fetch

      const response = await challengeSafeFetch(base)(`${origin}/resource`)

      expect(calls).toBe(1)
      expect(response.status).toBe(402)
    })
  })
})
