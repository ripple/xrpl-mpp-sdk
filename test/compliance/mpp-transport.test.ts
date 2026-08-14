import { Mppx, Store } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { charge } from '../../sdk/src/server/Charge.js'

/**
 * MPP HTTP transport conformance (mpp.dev).
 *
 * Proves that the xrpl charge method, wired into a real mppx server, produces
 * spec-conformant HTTP responses:
 * - `402` carries a `WWW-Authenticate: Payment` challenge and `Cache-Control: no-store`
 *   (mpp.dev HTTP 402 + Caching).
 * - A malformed credential is answered with `402` and an
 *   `application/problem+json` Problem Details body whose `type` is a
 *   `https://paymentauth.org/problems/...` URI (mpp.dev Error handling).
 *
 * These headers and bodies are emitted by the mppx HTTP transport, not by this
 * SDK; this suite is a regression guard against a mppx bump or a mis-wiring
 * that silently drops them.
 *
 * Network-free: both cases exercise the pre-verification `402` paths (no
 * credential, then a malformed credential rejected before verification), so no
 * XRPL round-trip happens. The successful-charge path (`Payment-Receipt` +
 * `Cache-Control: private`) requires on-chain settlement and is covered by the
 * devnet integration suite; the `private` header itself is set by the mppx
 * transport's `respondReceipt`.
 */

const SECRET = 'test-secret-key-conformance-0123456789abcdef'
const RECIPIENT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
const RESOURCE = 'https://api.example.com/resource'

function chargeHandler() {
  const mppx = Mppx.create({
    secretKey: SECRET,
    methods: [
      charge({
        recipient: RECIPIENT,
        network: 'testnet',
        store: Store.memory(),
        storeDurability: 'process-local',
      }),
    ],
  })
  return mppx['xrpl/charge']({ recipient: RECIPIENT, amount: '1000000', currency: 'XRP' })
}

describe('MPP HTTP transport conformance (mpp.dev)', () => {
  it('unpaid request -> 402 with WWW-Authenticate: Payment and Cache-Control: no-store', async () => {
    const handler = chargeHandler()
    const result = await handler(new Request(RESOURCE))

    // Narrow before reading `challenge`: it only exists on the 402 branch.
    if (result.status !== 402) throw new Error('expected a 402 challenge')
    const res = result.challenge
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Payment\b/)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('malformed credential -> 402 application/problem+json with a paymentauth problem type', async () => {
    const handler = chargeHandler()
    const result = await handler(
      new Request(RESOURCE, { headers: { Authorization: 'Payment @@not-base64url@@' } }),
    )

    // Narrow before reading `challenge`: it only exists on the 402 branch.
    if (result.status !== 402) throw new Error('expected a 402 challenge')
    const res = result.challenge
    expect(res.status).toBe(402)
    expect(res.headers.get('Content-Type')).toMatch(/application\/problem\+json/)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    // mpp.dev: a failed-credential 402 must still carry a FRESH challenge in
    // WWW-Authenticate alongside the problem body, so the client can retry.
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Payment\b/)

    const body = (await res.json()) as { type?: string; status?: number }
    expect(body.type).toMatch(/^https:\/\/paymentauth\.org\/problems\//)
    expect(body.status).toBe(402)
  })
})
