import { DiscoveryDocument, generate } from 'mppx/discovery'
import { Mppx, Store } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { charge } from '../../sdk/src/server/Charge.js'

/**
 * MPP Discovery conformance (mpp.dev).
 *
 * Discovery lets clients and registries learn an API's price before calling it:
 * the server serves an OpenAPI 3.1 document whose paid operations carry an
 * `x-payment-info.offers[]` extension (mpp.dev Discovery). Discovery is
 * advisory -- the runtime 402 Challenge stays authoritative -- but it must
 * describe our method correctly so agents and registries (e.g. MPPScan) can
 * list the API.
 *
 * This proves an mppx discovery document generated for a route protected by the
 * xrpl charge method produces a schema-valid OpenAPI 3.1 doc whose offer
 * advertises method 'xrpl', intent 'charge', and the configured amount/currency.
 * Network-free (pure document generation, no XRPL round-trip).
 */

const SECRET = 'test-secret-key-conformance-0123456789abcdef'
const RECIPIENT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'

describe('MPP Discovery conformance (mpp.dev)', () => {
  it('generates an OpenAPI 3.1 doc with a conformant x-payment-info offer for the xrpl charge route', () => {
    const mppx = Mppx.create({
      realm: 'api.example.com',
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

    const pay = mppx['xrpl/charge']({
      recipient: RECIPIENT,
      amount: '1000000',
      currency: 'XRP',
      description: 'One XRPL data pull',
    })

    const doc = generate(mppx, {
      info: { title: 'XRPL Paid API', version: '1.0.0' },
      routes: [{ handler: pay, method: 'get', path: '/v1/data' }],
    }) as {
      openapi: string
      paths: Record<
        string,
        Record<
          string,
          {
            'x-payment-info'?: {
              offers: Array<{
                method?: string
                intent?: string
                amount?: string
                currency?: string
              }>
            }
          }
        >
      >
    }

    // OpenAPI 3.1 shell + schema-valid discovery document.
    expect(doc.openapi).toBe('3.1.0')
    expect(() => DiscoveryDocument.parse(doc)).not.toThrow()

    // The paid route advertises a single conformant offer for our method.
    const operation = doc.paths['/v1/data']?.get
    expect(operation?.['x-payment-info']).toBeDefined()
    const offer = operation?.['x-payment-info']?.offers[0]
    expect(offer).toBeDefined()
    expect(offer?.method).toBe('xrpl')
    expect(offer?.intent).toBe('charge')
    expect(offer?.amount).toBe('1000000')
    expect(offer?.currency).toBe('XRP')
  })
})
