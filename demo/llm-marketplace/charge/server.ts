/**
 * LLM Marketplace -- Charge mode (native XRP) -- Server
 *
 * For every /complete request:
 *   1. Read prompt + maxTokens from the body
 *   2. Estimate input tokens locally, quote = (est × 10) + (maxTokens × 50) drops
 *   3. Issue an HTTP 402 challenge for that exact amount (one Payment tx on XRPL)
 *   4. Once the client's Payment tx is validated on-chain, call Anthropic with
 *      streaming and forward each token delta as an SSE `event: token`
 *   5. After Anthropic returns its usage report, emit an `event: done` with the
 *      real cost vs the worst-case quote (overpayment is the cost of pay-up-front)
 *
 * Price discovery is server-side only: the client has no upfront price table
 * and no `/info` lookup -- everything monetary lives in the 402 challenge.
 * `/info` is kept as a curl-friendly probe (marketplace address + model) but
 * the demo client never calls it.
 *
 * One LLM call = one on-chain XRPL Payment. No PayChannel here -- see
 * ../channel-stream/ for the per-token streaming variant. See ../charge-iou/
 * and ../charge-mpt/ for the same flow billed in an IOU or MPT.
 *
 * Run: npx tsx demo/llm-marketplace/charge/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../../../sdk/src/server/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { demoSecretKey } from '../../secret.js'
import {
  actualCostDrops,
  createAnthropic,
  DROPS_PER_INPUT_TOKEN,
  DROPS_PER_OUTPUT_TOKEN,
  estimateInputTokens,
  MODEL,
  quoteDrops,
} from '../shared/anthropic.js'

const PORT = 3003

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function toWebRequest(req: IncomingMessage, body?: string): Request {
  const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const val of v) headers.append(k, val)
    else headers.set(k, v)
  }
  const init: RequestInit = { method: req.method ?? 'GET', headers }
  if (body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = body
  }
  return new Request(url, init)
}

/** Buffer a non-streaming Response (used for the 402 challenge body). */
async function sendBuffered(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

/** Pipe a streaming Response (used for the SSE success body). */
async function pipeStream(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.flushHeaders?.()
  const reader = webRes.body!.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge, native XRP)'])
  log.separator()

  // Fail fast if the Anthropic key is missing -- better than crashing mid-request.
  try {
    createAnthropic()
  } catch (err: any) {
    log.error(err.message)
    process.exit(1)
  }

  log.loading('Funding marketplace wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: 'testnet' })
  log.wallet('Marketplace', wallet.address)
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price: ${DROPS_PER_INPUT_TOKEN} drops/input-token, ${DROPS_PER_OUTPUT_TOKEN} drops/output-token`,
  )
  log.separator()

  const store = Store.memory()
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [charge({ recipient: wallet.address, network: 'testnet', store })],
  })

  let callCount = 0

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/info') {
        // Identity-only probe. No pricing table here on purpose: price is
        // dynamic per call and lives exclusively in the 402 challenge.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            address: wallet.address,
            model: MODEL,
          }),
        )
        return
      }

      if (method === 'POST' && path === '/complete') {
        const raw = await readBody(req)
        const { prompt, maxTokens } = JSON.parse(raw) as { prompt: string; maxTokens: number }
        const inputEstimate = estimateInputTokens(prompt)
        const cost = quoteDrops(inputEstimate, maxTokens)

        log.request(
          'POST',
          '/complete',
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        const handler = mppx['xrpl/charge']({
          recipient: wallet.address,
          amount: String(cost),
          currency: 'XRP',
        })
        const result = await handler(toWebRequest(req, raw))
        if (result.status === 402) {
          log.challenge(
            `Quote: ~${inputEstimate}in × ${DROPS_PER_INPUT_TOKEN} + ${maxTokens}out × ${DROPS_PER_OUTPUT_TOKEN} = ${cost} drops`,
          )
          log.response(402, 'challenge sent')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        callCount++
        log.verify(`Payment validated on-chain (call #${callCount})`)

        // Build an SSE response backed by a ReadableStream and ask Mppx to
        // decorate it with the Payment-Receipt header before we pipe it back.
        const anthropic = createAnthropic()
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        })

        log.loading(`Calling Anthropic (${MODEL}) and streaming tokens...`)

        const encoder = new TextEncoder()
        const sseStream = new ReadableStream({
          async start(controller) {
            const enqueueEvent = (event: string, data: object) => {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              )
            }
            try {
              stream.on('text', (delta) => enqueueEvent('token', { value: delta }))
              const final = await stream.finalMessage()
              const inputTokens = final.usage.input_tokens
              const outputTokens = final.usage.output_tokens
              const real = actualCostDrops(inputTokens, outputTokens)
              enqueueEvent('done', {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                actual_cost: real,
                paid: cost,
                overpayment: cost - real,
              })
              log.success(
                `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} drops real (paid ${cost}, +${cost - real} overpay)`,
              )
            } catch (err: any) {
              log.error(`Anthropic error: ${err.message}`)
              enqueueEvent('error', { message: err.message })
            } finally {
              controller.close()
            }
          },
        })

        const sseResponse = new Response(sseStream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no', // disable nginx proxy buffering if any
          },
        })

        const decorated = result.withReceipt(sseResponse) as Response

        // The tx hash lives in the Payment-Receipt header that withReceipt() added.
        try {
          const receipt = Receipt.fromResponse(decorated)
          log.tx(receipt.reference, log.explorerLink(receipt.reference))
        } catch {
          // No header / parse error -- not fatal for delivery.
        }

        await pipeStream(decorated, res)
        return
      }

      res.writeHead(404)
      res.end('not found')
    } catch (err: any) {
      log.error(err.message)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(err.message)
      } else {
        res.end()
      }
    }
  })

  httpServer.listen(PORT, () => {
    log.separator()
    log.box([
      'Endpoints:',
      '',
      'GET  /info      -> marketplace address + model (no pricing -- see 402)',
      'POST /complete  -> { prompt, maxTokens } -> 402 quote -> SSE token stream',
      '',
      'Waiting for a client...',
    ])
    log.separator()
    log.server(`Listening on http://localhost:${PORT}`)
  })
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
