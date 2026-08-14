/**
 * LLM Marketplace -- Charge mode (multi-currency, MPP-native) -- Server
 *
 * The marketplace advertises **two payment options in a single 402** for
 * every /complete call:
 *   - native XRP (drops)
 *   - a test USD IOU minted by the marketplace
 *
 * This is the MPP/RFC-9110 standard pattern: a 402 carries multiple
 * `WWW-Authenticate: Payment ...` headers, one per acceptable challenge.
 * The client parses them all, picks one, and only THEN signs and pays.
 * There is no out-of-band negotiation -- no `payWith` field in the body,
 * no /quote endpoint, no rates exposed on /info. The 402 is the only
 * place where the price (and the choice) lives.
 *
 * How "two challenges in one 402" works mechanically (mppx):
 *   1. We register a single `xrpl/charge` method on one Mppx instance.
 *      The method's `verify` reads `expectedCurrency` from each
 *      *incoming* challenge -- so it transparently handles XRP and IOU.
 *   2. Per /complete request, we build **two configured handlers** by
 *      calling `mppx['xrpl/charge']({...})` twice with different runtime
 *      `amount + currency` -- the factory bakes those into each handler's
 *      canonical request, used by the dispatcher.
 *   3. `Mppx.compose(handlerXrp, handlerUsd)` returns a single handler.
 *      - No credential present -> calls both, merges their challenges
 *        into one 402 (two `WWW-Authenticate` headers, RFC 9110 §11.6.1).
 *      - Credential present -> compose() compares the credential's
 *        `amount + currency + recipient` to each handler's canonical
 *        request and dispatches to the matching one.
 *
 * After verification succeeds we read the credential's
 * `challenge.request.currency` to know which option the client honored
 * -- that drives the SSE `done` event's `currency_label` + cost numbers.
 *
 * Server-controlled wallets (same as ../charge-iou/):
 *   - issuer    -- mints the test `USD` IOU; runs `enableTransfers`.
 *   - recipient -- the single address that collects every payment, in
 *                  either currency. Opens a trustline to the issuer
 *                  eagerly so the first USD 402 lands cleanly.
 *
 * Run: npx tsx demo/llm-marketplace/charge-multi/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Credential, Receipt } from 'mppx'
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

const PORT = 3010
const NETWORK = 'testnet' as const

/** 3-char IOU code -- same convention as charge-iou/. */
const CURRENCY_CODE = 'USD'

/** USD pricing per token. Mirrors charge-iou/ so economics are identical. */
const USD_PER_INPUT_TOKEN = 0.0001
const USD_PER_OUTPUT_TOKEN = 0.0005

/** Initial USD allowance handed out by /faucet-usd. Demo-only bootstrap. */
const FAUCET_ALLOWANCE_USD = '10'

/** Trustline limit the recipient sets toward the issuer. */
const RECIPIENT_TRUSTLINE_LIMIT_USD = '1000000'

/** Trustline limit the server suggests the payer set toward the issuer. */
const PAYER_TRUSTLINE_LIMIT_USD = '1000'

/** Render a JS number as an XRPL IOU value string (15 sig digits max). */
function usdValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

function quoteUsd(inputEstimate: number, maxOutputTokens: number): string {
  return usdValue(inputEstimate * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN)
}

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

/**
 * Tag derived from the credential's `challenge.request.currency` so the
 * SSE done event and server-side logs can speak in human terms ("XRP"
 * vs "USD") without re-parsing the IOU JSON in three places.
 */
type Paid = { kind: 'XRP' } | { kind: 'USD' }

function classifyPaidCurrency(currencyStr: string): Paid {
  if (currencyStr === 'XRP') return { kind: 'XRP' }
  return { kind: 'USD' }
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge, multi-challenge 402)'])
  log.separator()

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
  log.info(`USD issued by ${issuer.address}`)
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price (XRP path): ${DROPS_PER_INPUT_TOKEN} drops/input-token, ` +
      `${DROPS_PER_OUTPUT_TOKEN} drops/output-token`,
  )
  log.info(
    `Price (USD path): ${USD_PER_INPUT_TOKEN} ${CURRENCY_CODE}/input-token, ` +
      `${USD_PER_OUTPUT_TOKEN} ${CURRENCY_CODE}/output-token`,
  )
  log.separator()

  log.loading('Issuer enables transfers (asfDefaultRipple)...')
  const transfers = await issuer.enableTransfers({ network: NETWORK })
  log.tx(transfers.hash, log.explorerLink(transfers.hash))

  const currency = { currency: CURRENCY_CODE, issuer: issuer.address }
  const currencyJson = JSON.stringify(currency)

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

  // SINGLE Mppx instance with a SINGLE xrpl/charge method. The method's
  // `verify` is currency-agnostic -- it reads `expectedCurrency` from
  // whichever challenge the incoming credential echoes. We turn this
  // into "two payment options" purely at request time by calling the
  // handler factory twice with different `amount + currency` overrides.
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [
      charge({
        recipient: recipient.address,
        network: NETWORK,
        store: Store.memory(),
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
        // Identity-only probe. We mention the marketplace address + the
        // IOU identifier (so the client can open a trustline ahead of
        // time) but we deliberately DO NOT advertise per-token rates --
        // the only place a price ever appears is the 402 challenge.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            recipient: recipient.address,
            issuer: issuer.address,
            network: NETWORK,
            model: MODEL,
            // The client uses this to open the right trustline. It is
            // "which token to opt in to", not "what it costs".
            iou: {
              currency,
              label: CURRENCY_CODE,
              faucetAllowanceUsd: FAUCET_ALLOWANCE_USD,
              payerTrustlineLimitUsd: PAYER_TRUSTLINE_LIMIT_USD,
            },
          }),
        )
        return
      }

      // Demo-only bootstrap: hand out a tiny USD allowance so the agent
      // has something to spend if it picks the USD path.
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
        const { prompt, maxTokens } = JSON.parse(raw) as {
          prompt: string
          maxTokens: number
        }
        const inputEstimate = estimateInputTokens(prompt)
        const xrpQuoteDrops = String(quoteDrops(inputEstimate, maxTokens))
        const usdQuote = quoteUsd(inputEstimate, maxTokens)

        log.request(
          'POST',
          '/complete',
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        // Build a fresh `compose` per request: each handler bakes in the
        // per-call quote for its currency. compose() will either merge
        // the two challenges into one 402 (no credential) or dispatch to
        // the matching handler based on the credential's currency+amount.
        const composed = Mppx.compose(
          mppx['xrpl/charge']({
            recipient: recipient.address,
            amount: xrpQuoteDrops,
            currency: 'XRP',
          }),
          mppx['xrpl/charge']({
            recipient: recipient.address,
            amount: usdQuote,
            currency: currencyJson,
          }),
        )

        const input = toWebRequest(req, raw)
        const result = await composed(input)

        if (result.status === 402) {
          // The 402 response carries BOTH challenges in WWW-Authenticate
          // headers (one per acceptable option). The client parses them
          // with Challenge.fromResponseList and picks one.
          log.challenge(
            `Quote XRP: ~${inputEstimate}in × ${DROPS_PER_INPUT_TOKEN} + ${maxTokens}out × ` +
              `${DROPS_PER_OUTPUT_TOKEN} = ${xrpQuoteDrops} drops`,
          )
          log.challenge(
            `Quote USD: ~${inputEstimate}in × ${USD_PER_INPUT_TOKEN} + ${maxTokens}out × ` +
              `${USD_PER_OUTPUT_TOKEN} = ${usdQuote} ${CURRENCY_CODE}`,
          )
          log.response(402, 'multi-challenge sent (XRP + USD)')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        // 200 -- compose() dispatched the credential to whichever handler
        // matched and verify succeeded on-chain. Read the credential to
        // find out which currency the client actually honored.
        const credential = Credential.fromRequest(input)
        const chalReq = credential.challenge.request as Record<string, unknown>
        const paid = classifyPaidCurrency(String(chalReq.currency ?? ''))
        const paidAmount = String(chalReq.amount ?? '')

        callCount++
        log.verify(
          `${paid.kind === 'XRP' ? 'XRP Payment' : 'IOU Payment'} validated on-chain ` +
            `(call #${callCount}, paid ${paidAmount} ` +
            `${paid.kind === 'XRP' ? 'drops' : CURRENCY_CODE})`,
        )

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

              if (paid.kind === 'XRP') {
                const real = actualCostDrops(inputTokens, outputTokens)
                const paidNum = Number(paidAmount)
                enqueueEvent('done', {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  pay_with: paid.kind,
                  actual_cost: String(real),
                  paid: paidAmount,
                  overpayment: String(paidNum - real),
                  currency_label: 'XRP',
                })
                log.success(
                  `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} drops real ` +
                    `(paid ${paidAmount}, +${paidNum - real} overpay)`,
                )
              } else {
                const real = actualCostUsd(inputTokens, outputTokens)
                const overpayment = usdValue(Number(paidAmount) - Number(real))
                enqueueEvent('done', {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  pay_with: paid.kind,
                  actual_cost: real,
                  paid: paidAmount,
                  overpayment,
                  currency_label: CURRENCY_CODE,
                })
                log.success(
                  `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} ${CURRENCY_CODE} ` +
                    `real (paid ${paidAmount}, +${overpayment} overpay)`,
                )
              }
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
      'GET  /info        -> recipient, issuer, model, IOU identifier',
      '                     (no pricing -- see 402)',
      'POST /faucet-usd  -> { holder } -> issues 10 USD (demo bootstrap)',
      'POST /complete    -> { prompt, maxTokens }',
      '                     -> 402 with TWO challenges (XRP + USD), client picks',
      '                     -> on retry with credential, dispatched + SSE token stream',
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
