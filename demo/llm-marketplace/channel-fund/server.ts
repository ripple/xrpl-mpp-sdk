/**
 * LLM Marketplace -- PayChannel mode + just-in-time fund -- Server
 *
 * Functionally identical to channel/server.ts -- the server has nothing
 * to do with the client's funding strategy. It accepts whatever cumulative
 * the latest voucher commits to, and rejects with a typed CHANNEL_EXHAUSTED
 * when that cumulative exceeds the on-chain channel deposit. The matching
 * client (channel-fund/client.ts) reacts to that error by submitting a
 * PaymentChannelFund and retrying, instead of pre-funding the channel
 * with a worst-case lump sum.
 *
 * About error surfacing:
 *   When the channel server method's verify() throws an
 *   AmountExceedsDepositError, mppx wraps it in a fresh 402 response whose
 *   body is an RFC 9457 Problem Details document with
 *   `type: "https://paymentauth.org/problems/session/amount-exceeds-deposit"`.
 *   The matching client peeks at the body of any 402 it receives and, if
 *   it is that specific Problem type, submits a PaymentChannelFund and
 *   retries. We do NOT translate the error to a custom 4xx server-side --
 *   that would require intercepting verify(), but mppx already catches it
 *   internally before we'd get a chance.
 *
 * Differences from channel/server.ts:
 *   - PORT 3006 (so both demos can run side-by-side).
 *
 * Run: npx tsx demo/llm-marketplace/channel-fund/server.ts
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

const PORT = 3006
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

async function sendBuffered(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

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
  log.box(['XRPL MPP -- LLM Marketplace (channel + just-in-time fund)'])
  log.separator()

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
  let channelId: string | null = null
  let voucherHandler: SessionHandler | null = null

  let callCount = 0
  let voucherCumulative = '0'
  let actualCumulative = 0

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // Identity probe. As in channel/, we do NOT advertise per-token
      // rates here. Per-call quotes ride on the 402 challenge that
      // /complete returns; CHANNEL_EXHAUSTED 402s additionally carry
      // the cumulative + available deposit in their Problem Details
      // body, which the client parses to size each PaymentChannelFund.
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

      if (method === 'POST' && path === '/register') {
        const raw = await readBody(req)
        const { publicKey } = JSON.parse(raw) as { publicKey: string }
        if (!publicKey) {
          res.writeHead(400)
          res.end('publicKey required')
          return
        }

        // Passing `wallet` enables MPP-spec server-initiated close (see
        // https://mpp.dev/payment-methods/tempo/session): a background
        // sweeper submits a PaymentChannelClaim with the latest voucher
        // whenever a channel goes idle, then marks it finalized so
        // subsequent vouchers are rejected with CHANNEL_CLOSED.
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

        voucherHandler = mppx['xrpl/session']({
          amount: '1',
          channelId,
          recipient: wallet.address,
        })

        log.response(200, 'channel open confirmed')
        await sendBuffered(openResponse, res)
        return
      }

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

        const handler = mppx['xrpl/session']({
          amount: String(cost),
          channelId,
          recipient: wallet.address,
        })
        const result = await handler(toWebRequest(req, raw))

        if (result.status === 402) {
          // Two flavours of 402 reach here, both via the same path:
          //   - Initial challenge (no credential): standard "please pay".
          //   - Verify failure (credential present): mppx caught the
          //     thrown PaymentError -- typically AmountExceedsDeposit
          //     when the cumulative exceeds the on-chain deposit -- and
          //     wrapped it in a Problem Details body. The client looks
          //     at the body's `type` field to branch into a fund+retry.
          // We clone the Response so we can peek at the body for nicer
          // server-side logs without consuming it before sendBuffered.
          const challengeRes = result.challenge as Response
          let exhausted = false
          try {
            const peek = challengeRes.clone()
            const bodyText = await peek.text()
            exhausted =
              bodyText.includes('amount-exceeds-deposit') || bodyText.includes('CHANNEL_EXHAUSTED')
          } catch {
            // Body not peekable -- fall through with exhausted=false.
          }

          if (exhausted) {
            log.fix(
              `Verify rejected credential: cumulative > on-chain deposit. ` +
                `Client should PaymentChannelFund and retry.`,
            )
            log.response(402, 'amount-exceeds-deposit (Problem Details body)')
          } else {
            log.challenge(
              `Quote: ~${inputEstimate}in × ${DROPS_PER_INPUT_TOKEN} + ${maxTokens}out × ${DROPS_PER_OUTPUT_TOKEN} = ${cost} drops`,
            )
            log.response(402, 'challenge sent')
          }
          await sendBuffered(challengeRes, res)
          return
        }

        callCount++

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
            'X-Accel-Buffering': 'no',
          },
        })

        const decorated = result.withReceipt(sseResponse) as Response
        await pipeStream(decorated, res)
        return
      }

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
      'POST /complete   -> 402 (action: voucher) -> SSE token stream on success',
      '                    402 with Problem Details `amount-exceeds-deposit`',
      '                    when cumulative > on-chain deposit (client tops up + retries)',
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
