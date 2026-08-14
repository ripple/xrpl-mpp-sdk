/**
 * LLM Marketplace -- PayChannel mode -- Server
 *
 * Same marketplace as charge/, but billed through a single PayChannel:
 *   1. /open       -> 402 (xrpl/channel, action: 'open'). The client ships a
 *                     signed PaymentChannelCreate blob inside the credential;
 *                     the server submits it on-chain and returns the channelId
 *                     via the Payment-Receipt header.
 *   2. /complete   -> 402 (xrpl/channel, action: 'voucher'). The client signs
 *                     a cumulative PayChannel claim for `prev + worstCaseQuote`,
 *                     the server verifies it OFF-chain (no tx), then calls
 *                     Anthropic and streams tokens back as SSE.
 *   3. /summary    -> server-side accounting: voucher cumulative vs real cost.
 *
 * Three prompts therefore settle with TWO on-chain txs in total
 * (open + client-side close) instead of three Payment txs in charge mode.
 *
 * Run: npx tsx demo/llm-marketplace/channel/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { channel } from '../../../sdk/src/channel/server/Channel.js'
import { storeKeys } from '../../../sdk/src/utils/keys.js'
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

const PORT = 3005
const NETWORK = 'testnet' as const

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

/** Buffer a non-streaming Response (used for the 402 challenge body and JSON). */
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
  log.box(['XRPL MPP -- LLM Marketplace (channel mode)'])
  log.separator()

  // Fail fast if the Anthropic key is missing -- better than crashing mid-request.
  try {
    createAnthropic()
  } catch (err: any) {
    log.error(err.message)
    process.exit(1)
  }

  log.loading('Funding marketplace wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Marketplace', wallet.address)
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price: ${DROPS_PER_INPUT_TOKEN} drops/input-token, ${DROPS_PER_OUTPUT_TOKEN} drops/output-token`,
  )
  log.separator()

  const MPPX_SECRET = demoSecretKey()
  const store = Store.memory()

  // The xrpl/channel method needs the payer's publicKey at construction time
  // (it's used to verify every claim signature). The client supplies it via
  // POST /register before any payment-gated request can run.
  // Typed through a factory: bare `ReturnType<typeof Mppx.create>` resolves to
  // the generic default `Mppx<Methods, AnyTransport>`, which knows nothing about
  // our method, so neither the assignment nor an `['xrpl/session']` index
  // type-checks against it.
  const buildMppx = (channelMethod: ReturnType<typeof channel>) =>
    Mppx.create({ secretKey: MPPX_SECRET, methods: [channelMethod] })
  let mppx: ReturnType<typeof buildMppx> | null = null
  /** The 402-gated request handler a session challenge produces. */
  type SessionHandler = ReturnType<ReturnType<typeof buildMppx>['xrpl/session']>
  let openHandler: SessionHandler | null = null

  // Per-channel state, populated after /open succeeds.
  let channelId: string | null = null
  let voucherHandler: SessionHandler | null = null

  // Server-side accounting -- shown via /summary at the end.
  let callCount = 0
  let voucherCumulative = '0' // sum of worst-case quotes signed by the client
  let actualCumulative = 0 // sum of actual Anthropic costs

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // ── /info -- identity probe (no pricing) ────────────────────────────
      // We do NOT expose per-token rates here. Every per-call quote is
      // announced inside the 402 challenge on /complete; the client
      // signs whatever cumulative it has just been asked to commit to.
      if (method === 'GET' && path === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            address: wallet.address,
            model: MODEL,
            network: NETWORK,
          }),
        )
        return
      }

      // ── /register -- client shares their channel publicKey ──────────────
      // The xrpl/channel server method needs the publicKey at construction
      // time (it's used to verify every claim). We delay creating the Mppx
      // instance until the client tells us which key to expect.
      if (method === 'POST' && path === '/register') {
        const raw = await readBody(req)
        const { publicKey } = JSON.parse(raw) as { publicKey: string }
        if (!publicKey) {
          res.writeHead(400)
          res.end('publicKey required')
          return
        }

        // Passing `wallet` enables MPP-spec server-initiated close: a
        // background sweeper submits a PaymentChannelClaim with the
        // latest voucher whenever the channel goes idle (default 30s),
        // then marks it finalized in the store so no further voucher is
        // accepted. See https://mpp.dev/payment-methods/tempo/session
        // for the spec ("Either party can close the channel. The server
        // calls close() ... with the highest voucher").
        const channelMethod = channel({
          publicKey,
          network: NETWORK,
          store,
          // Development only: process-local store, unsafe above one instance.
          storeDurability: 'process-local',
          wallet,
          autoClose: {
            onClose: ({ channelId: cid, cumulative, txHash }) => {
              log.success(
                `Auto-closed channel ${cid.slice(0, 16)}... -- ` +
                  `claimed cumulative ${cumulative} drops`,
              )
              log.tx(txHash, log.explorerLink(txHash))
            },
          },
        })
        mppx = buildMppx(channelMethod)

        // Open challenge: amount '0' because the client commits no value at
        // open-time -- the placeholder signature carries 0 drops.
        openHandler = mppx['xrpl/session']({
          amount: '0',
          channelId: '',
          recipient: wallet.address,
        })

        log.info(`Registered payer publicKey: ${publicKey.slice(0, 16)}...`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, recipient: wallet.address }))
        return
      }

      // ── /open -- server-managed PaymentChannelCreate ────────────────────
      if (method === 'GET' && path === '/open') {
        if (!openHandler || !mppx) {
          res.writeHead(503)
          res.end('Server not configured -- POST /register first')
          return
        }
        log.request(method, path)
        const result = await openHandler(toWebRequest(req))

        if (result.status === 402) {
          log.challenge('Open challenge sent (xrpl/channel, action: open)')
          log.response(402, 'challenge sent')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        // result.withReceipt() injects the Payment-Receipt header carrying the
        // canonical "open:{channelId}:{txHash}" reference -- read it before
        // forwarding the response so we know what to bill claims against.
        const openResponse = result.withReceipt(
          Response.json({ message: 'Channel opened by server' }),
        ) as Response

        const receiptHeader = openResponse.headers.get('Payment-Receipt')
        if (!receiptHeader) {
          res.statusCode = 500
          res.end('No Payment-Receipt header in open response')
          return
        }

        const receipt = Receipt.deserialize(receiptHeader)
        const parts = receipt.reference.split(':')
        channelId = parts[1] ?? null
        const openTxHash = parts[2] ?? ''

        if (!channelId) {
          res.statusCode = 500
          res.end('Could not extract channelId from receipt reference')
          return
        }

        log.success(`Channel opened on-chain: ${channelId}`)
        log.tx(openTxHash, log.explorerLink(openTxHash))

        // Now we know the channelId we can bind voucher claims to it. The
        // 'amount' here is a placeholder -- the real per-call quote is
        // injected fresh on every /complete request below.
        voucherHandler = mppx['xrpl/session']({
          amount: '1',
          channelId,
          recipient: wallet.address,
        })

        log.response(200, 'channel open confirmed')
        await sendBuffered(openResponse, res)
        return
      }

      // ── /complete -- 402-gated streaming completion ─────────────────────
      if (method === 'POST' && path === '/complete') {
        if (!voucherHandler || !mppx || !channelId) {
          res.writeHead(503)
          res.end('Channel not open yet -- GET /open first')
          return
        }

        const raw = await readBody(req)
        const { prompt, maxTokens } = JSON.parse(raw) as { prompt: string; maxTokens: number }
        const inputEstimate = estimateInputTokens(prompt)
        const cost = quoteDrops(inputEstimate, maxTokens)

        log.request(
          method,
          path,
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        // Re-bind the voucher handler with the per-call quote so the 402
        // challenge advertises the right amount.
        const handler = mppx['xrpl/session']({
          amount: String(cost),
          channelId,
          recipient: wallet.address,
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

        // Pull the freshly verified cumulative directly from the store. The
        // channel method writes the network-namespaced channel key at every accepted
        // claim, so this is the source of truth -- no need to track it in
        // the demo's own state.
        const state = (await store.get(storeKeys(NETWORK).channel(channelId))) as any
        voucherCumulative = state?.cumulative ?? voucherCumulative

        log.verify(`Voucher #${callCount} verified -- cumulative: ${voucherCumulative} drops`)

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
              actualCumulative += real
              enqueueEvent('done', {
                call: callCount,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                actual_cost: real,
                paid: cost,
                overpayment: cost - real,
                voucher_cumulative: voucherCumulative,
              })
              log.success(
                `Stream done #${callCount}: ${inputTokens}in + ${outputTokens}out -> ${real} drops real (paid ${cost}, +${cost - real} overpay)`,
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
        await pipeStream(decorated, res)
        return
      }

      // ── /summary -- server-side accounting (no payment, read-only) ──────
      if (method === 'GET' && path === '/summary') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            channelId,
            callCount,
            voucherCumulative,
            actualCumulative,
            overpayment: Number(voucherCumulative) - actualCumulative,
          }),
        )
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
      'GET  /info       -> marketplace address + model (no pricing -- see 402)',
      'POST /register   -> { publicKey } -> arms the xrpl/channel server method',
      'GET  /open       -> 402 (action: open) -> server submits PaymentChannelCreate',
      'POST /complete   -> 402 (action: voucher) -> SSE token stream',
      'GET  /summary    -> server-side accounting (voucher vs actual cost)',
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
