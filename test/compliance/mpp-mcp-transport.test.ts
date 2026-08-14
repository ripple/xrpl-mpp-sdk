import { Mppx, Store, Transport } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { charge } from '../../sdk/src/server/Charge.js'

/**
 * MPP MCP / JSON-RPC transport conformance (mpp.dev).
 *
 * The xrpl charge method is transport-agnostic: the same `Method.from` schema
 * that drives the HTTP transport must also carry over the MCP transport, where
 * a payment requirement is a JSON-RPC error with code `-32042` and the
 * challenge travels in `error.data.challenges` (mpp.dev MCP and JSON-RPC
 * transport). This suite proves an unpaid tool call against an mppx MCP server
 * built with our method produces that conformant `-32042` challenge.
 *
 * Uses the dependency-free raw `Transport.mcp()` (no @modelcontextprotocol/sdk
 * required). Network-free: the unpaid path issues a challenge without any XRPL
 * round-trip. Settlement over MCP is covered by the HTTP-path integration
 * suite (verification is transport-independent).
 */

const SECRET = 'test-secret-key-conformance-0123456789abcdef'
const RECIPIENT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'

function mcpChargeHandler() {
  const payment = Mppx.create({
    // MCP requests carry no Host, so set an explicit realm (there is nothing to
    // auto-detect from an mcp:// URL).
    realm: 'mcp.example.com',
    secretKey: SECRET,
    methods: [
      charge({
        recipient: RECIPIENT,
        network: 'testnet',
        store: Store.memory(),
        storeDurability: 'process-local',
      }),
    ],
    transport: Transport.mcp(),
  })
  return payment['xrpl/charge']({ recipient: RECIPIENT, amount: '1000000', currency: 'XRP' })
}

describe('MPP MCP transport conformance (mpp.dev)', () => {
  it('unpaid tool call -> JSON-RPC -32042 carrying the xrpl charge challenge', async () => {
    const handler = mcpChargeHandler()

    const request = {
      jsonrpc: '2.0' as const,
      id: 7,
      method: 'tools/call',
      params: { name: 'premium-tool', arguments: {} },
    }
    const result = await handler(request as never)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error('expected a 402 challenge')

    const response = result.challenge as {
      jsonrpc: string
      id: number
      error: {
        code: number
        message: string
        data: {
          httpStatus: number
          challenges: Array<{ method: string; intent: string; id: string }>
        }
      }
    }
    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe(7)
    expect(response.error.code).toBe(-32042)
    expect(response.error.data.httpStatus).toBe(402)

    const challenge = response.error.data.challenges[0]
    expect(challenge).toBeDefined()
    expect(challenge.method).toBe('xrpl')
    expect(challenge.intent).toBe('charge')
    expect(challenge.id).toMatch(/.+/)
  })
})
