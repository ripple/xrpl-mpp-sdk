/**
 * LLM Marketplace -- Charge mode (IOU) -- Server
 *
 * Same wire flow as ../charge/, but per-prompt billing is denominated
 * in an XRPL **issued currency (IOU)** instead of native XRP drops.
 * The MPP wire protocol does not change -- only the currency on the
 * 402 challenge and on the `Payment` tx the client signs.
 *
 * Why bill in an IOU?
 *
 *   "Pay 3000 drops" is hard to translate into a budget; "pay 0.30 USD"
 *   is not. A pay-per-prompt API priced in a USD-pegged IOU lets the
 *   caller (a human or another agent) reason about cost in the same
 *   units as the upstream provider's invoice -- without exposing them
 *   to XRP/USD volatility. The same code path works for *any* IOU,
 *   stablecoin or otherwise: only the recipient's trustline and the
 *   challenge currency change.
 *
 * Currency code in this demo:
 *
 *   We mint our own test IOU with the 3-char code `USD`. XRPL native
 *   IOU codes are 3 ASCII chars; codes longer than 3 chars (e.g. real
 *   `RLUSD`, which is 5) must be hex-encoded as a 40-char string in
 *   the wire format. Since this demo controls the issuer, the short
 *   code keeps logs human-readable. On mainnet, point the recipient's
 *   trustline at any production issuer (e.g. Ripple's RLUSD -- see
 *   `RLUSD_MAINNET` in `sdk/src/constants.ts`).
 *
 * Marketplace setup (two server-controlled wallets):
 *   - issuer    -- mints a *test* `USD` IOU on testnet. We own its seed
 *                  so the demo needs zero external bootstrap. This is
 *                  NOT any production stablecoin; on mainnet the
 *                  recipient would open a trustline to a real issuer
 *                  instead. Same wire, same charge code path -- only
 *                  the issuer and the currency code change.
 *   - recipient -- receives every per-prompt USD payment. Opens a
 *                  trustline to the issuer eagerly at boot so the very
 *                  first 402 lands without `PAYMENT_PATH_FAILED`.
 *
 * Per /complete request:
 *   1. Read prompt + maxTokens from the body
 *   2. Estimate input tokens locally, quote =
 *        (est × USD_PER_INPUT_TOKEN) + (maxTokens × USD_PER_OUTPUT_TOKEN)
 *   3. Issue an HTTP 402 challenge for that exact amount in USD
 *      (one IOU Payment tx on XRPL)
 *   4. Once validated on-chain, call Anthropic with streaming and forward
 *      each token delta as an SSE `event: token`
 *   5. After Anthropic returns its usage report, emit `event: done` with
 *      the real cost vs the worst-case quote (overpayment is the cost of
 *      pay-up-front; identical to ../charge/, just denominated in an IOU)
 *
 * Run: npx tsx demo/llm-marketplace/charge-iou/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../../../sdk/src/server/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { demoSecretKey } from '../../secret.js'
import { createAnthropic, estimateInputTokens, MODEL } from '../shared/anthropic.js'

const PORT = 3008
const NETWORK = 'testnet' as const

/**
 * Currency code -- 3 ASCII chars (XRPL native IOU format). We use `USD`
 * as a stand-in for an RLUSD-style stablecoin because real `RLUSD` is
 * 5 chars and requires the 40-char hex-encoded currency code format,
 * which would be opaque in a demo. The economic story is identical.
 */
const CURRENCY_CODE = 'USD'

/**
 * Demo pricing in USD per token. ~100× Claude Haiku 4.5 real cost
 * ($1/MTok in, $5/MTok out) to keep numbers visible in the terminal
 * while preserving the 1:5 input/output ratio. A typical 60-output
 * answer settles at ~0.035 USD per call, well within the 10 USD demo
 * allowance below.
 */
const USD_PER_INPUT_TOKEN = 0.0001
const USD_PER_OUTPUT_TOKEN = 0.0005

/** Initial USD allowance handed out by /faucet-usd. Demo-only bootstrap. */
const FAUCET_ALLOWANCE_USD = '10'

/** Trustline limit the recipient sets toward the issuer. */
const RECIPIENT_TRUSTLINE_LIMIT_USD = '1000000'

/** Trustline limit the server suggests the payer set toward the issuer. */
const PAYER_TRUSTLINE_LIMIT_USD = '1000'

/**
 * Render a JS number as an XRPL IOU value string. IOUs allow up to 15
 * significant digits; we round to 12 to absorb floating-point noise and
 * strip trailing zeros so log lines stay readable.
 */
function usdValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

/** Worst-case quote in USD, used as the 402 challenge amount. */
function quoteUsd(inputEstimate: number, maxOutputTokens: number): string {
  return usdValue(inputEstimate * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN)
}

/** Actual cost in USD once Anthropic has returned its usage report. */
function actualCostUsd(inputTokens: number, outputTokens: number): string {
  return usdValue(inputTokens * USD_PER_INPUT_TOKEN + outputTokens * USD_PER_OUTPUT_TOKEN)
}

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
  log.box(['XRPL MPP -- LLM Marketplace (charge, IOU billing)'])
  log.separator()

  // Fail fast if the Anthropic key is missing -- better than crashing mid-request.
  try {
    createAnthropic()
  } catch (err: any) {
    log.error(err.message)
    process.exit(1)
  }

  log.loading('Funding issuer + recipient wallets via testnet faucet (parallel)...')
  const [issuer, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Issuer (USD treasury)', issuer.address)
  log.wallet('Recipient (marketplace)', recipient.address)
  log.info(`Currency: ${CURRENCY_CODE} issued by ${issuer.address}`)
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price: ${USD_PER_INPUT_TOKEN} ${CURRENCY_CODE}/input-token, ` +
      `${USD_PER_OUTPUT_TOKEN} ${CURRENCY_CODE}/output-token`,
  )
  log.separator()

  // Issuer must enable asfDefaultRipple so holders can pay through us.
  log.loading('Issuer enables transfers (asfDefaultRipple)...')
  const transfers = await issuer.enableTransfers({ network: NETWORK })
  log.tx(transfers.hash, log.explorerLink(transfers.hash))

  // Recipient opens a trustline to the issuer. The client-side path resolver
  // requires the recipient's trustline to already exist when it runs
  // ripple_path_find for the first 402 -- otherwise the very first IOU
  // payment fails with PAYMENT_PATH_FAILED. Doing it eagerly at boot also
  // keeps /complete latency consistent on the first call.
  const currency = { currency: CURRENCY_CODE, issuer: issuer.address }
  log.loading(
    `Recipient accepts ${CURRENCY_CODE} (trustline, limit ${RECIPIENT_TRUSTLINE_LIMIT_USD})...`,
  )
  const recipientAccept = await recipient.acceptToken(currency, {
    network: NETWORK,
    limit: RECIPIENT_TRUSTLINE_LIMIT_USD,
  })
  if ('hash' in recipientAccept && recipientAccept.hash) {
    log.tx(recipientAccept.hash, log.explorerLink(recipientAccept.hash))
  }
  log.success(`Recipient trustline status: ${recipientAccept.status}`)
  log.separator()

  const currencyJson = JSON.stringify(currency)
  const store = Store.memory()
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [
      charge({
        recipient: recipient.address,
        currency,
        network: NETWORK,
        store,
        // Development only: process-local store, unsafe above one instance.
        storeDurability: 'process-local',
      }),
    ],
  })

  let callCount = 0

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/info') {
        // Setup-only probe. We expose the issuer + currency *identifier*
        // here because the client needs it to open a trustline before any
        // IOU payment can clear -- this is "which token" info, not "what
        // it costs". The per-call price is discovered exclusively from
        // the 402 challenge on /complete.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: issuer.address,
            recipient: recipient.address,
            network: NETWORK,
            currency,
            model: MODEL,
            faucetAllowanceUsd: FAUCET_ALLOWANCE_USD,
            payerTrustlineLimitUsd: PAYER_TRUSTLINE_LIMIT_USD,
          }),
        )
        return
      }

      // Demo-only bootstrap: hand out a tiny USD allowance so the agent
      // has something to spend. In production this would be replaced by
      // a paid top-up (card payment, DEX swap, fiat on-ramp, etc.) and
      // the recipient would trust a real USD-pegged issuer instead.
      if (method === 'POST' && path === '/faucet-usd') {
        const raw = await readBody(req)
        const { holder } = JSON.parse(raw) as { holder: string }
        if (!holder) {
          res.writeHead(400)
          res.end('holder address required')
          return
        }
        log.request(method, path, `holder=${holder}`)
        log.loading(`Issuing ${FAUCET_ALLOWANCE_USD} ${CURRENCY_CODE} to ${holder}...`)
        const issued = await issuer.issue(holder, FAUCET_ALLOWANCE_USD, currency, {
          network: NETWORK,
        })
        log.tx(issued.hash, log.explorerLink(issued.hash))
        log.success(`Faucet OK -- holder credited with ${FAUCET_ALLOWANCE_USD} ${CURRENCY_CODE}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            amount: FAUCET_ALLOWANCE_USD,
            currency,
            txHash: issued.hash,
          }),
        )
        return
      }

      if (method === 'POST' && path === '/complete') {
        const raw = await readBody(req)
        const { prompt, maxTokens } = JSON.parse(raw) as { prompt: string; maxTokens: number }
        const inputEstimate = estimateInputTokens(prompt)
        const cost = quoteUsd(inputEstimate, maxTokens)

        log.request(
          'POST',
          '/complete',
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        const handler = mppx['xrpl/charge']({
          recipient: recipient.address,
          amount: cost,
          currency: currencyJson,
        })
        const result = await handler(toWebRequest(req, raw))

        if (result.status === 402) {
          log.challenge(
            `Quote: ~${inputEstimate}in × ${USD_PER_INPUT_TOKEN} + ${maxTokens}out × ${USD_PER_OUTPUT_TOKEN} = ${cost} ${CURRENCY_CODE}`,
          )
          log.response(402, 'challenge sent')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        callCount++
        log.verify(`IOU Payment validated on-chain (call #${callCount})`)

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
              const real = actualCostUsd(inputTokens, outputTokens)
              const overpayment = usdValue(Number(cost) - Number(real))
              enqueueEvent('done', {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                actual_cost: real,
                paid: cost,
                overpayment,
                currency: CURRENCY_CODE,
              })
              log.success(
                `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} ${CURRENCY_CODE} ` +
                  `real (paid ${cost}, +${overpayment} overpay)`,
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
      'GET  /info        -> issuer, recipient, USD currency, model (no pricing -- see 402)',
      'POST /faucet-usd  -> { holder } -> issues 10 USD (demo bootstrap)',
      'POST /complete    -> { prompt, maxTokens } -> 402 quote in USD -> SSE token stream',
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
