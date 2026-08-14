/**
 * LLM Marketplace -- Charge mode (RLUSD, client swaps XRP -> RLUSD) -- Server
 *
 * Same idea as ../charge-swap/ but with a crucial twist: the marketplace
 * bills in **real testnet RLUSD** (Ripple's USD-pegged stablecoin) and
 * the client sources it by swapping **native XRP** -- the asset every
 * testnet wallet already holds straight out of the faucet.
 *
 * Why this is simpler (and more "production-shaped") than ../charge-swap/:
 *
 *   - ../charge-swap/ had to mint its own `USD` + `CRD` IOUs, seed an LP,
 *     and bootstrap a USD/CRD AMM pool at boot, because no organic
 *     liquidity exists for tokens it just minted.
 *   - Here, RLUSD is issued by Ripple and there is already a deep,
 *     **public** XRP/RLUSD AMM pool on testnet. The marketplace mints
 *     nothing, seeds no liquidity, and -- critically -- **never funds a
 *     wallet in RLUSD**. The only RLUSD it ever touches is the RLUSD the
 *     client pays it.
 *
 * So the server side collapses to a single wallet:
 *
 *   - recipient -- collects every RLUSD payment. Opens a trustline to the
 *                  RLUSD testnet issuer eagerly at boot so the very first
 *                  402 lands without PAYMENT_PATH_FAILED. Faucet-funded
 *                  with XRP only (for the trustline reserve + fees); it
 *                  starts with 0 RLUSD and that is fine -- it only ever
 *                  receives.
 *   - (no issuer)  -- Ripple operates the RLUSD issuer.
 *   - (no LP / AMM) -- liquidity is the public testnet XRP/RLUSD pool.
 *
 * The 402 carries exactly one `WWW-Authenticate: Payment` challenge,
 * denominated in RLUSD. The client holds no RLUSD; it must discover the
 * public XRP/RLUSD market on-chain, swap a slice of its faucet XRP into
 * the exact RLUSD the challenge asks for, and only THEN retry /complete.
 * The server doesn't know (or care) where the RLUSD came from, as long
 * as the on-chain Payment delivers it to `recipient`.
 *
 * Run: npx tsx demo/llm-marketplace/charge-swap-rlusd/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Credential, Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { RLUSD_TESTNET } from '../../../sdk/src/constants.js'
import { charge } from '../../../sdk/src/server/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { demoSecretKey } from '../../secret.js'
import { createAnthropic, estimateInputTokens, MODEL } from '../shared/anthropic.js'

const PORT = 3012
const NETWORK = 'testnet' as const

/**
 * The IOU the marketplace charges in: real testnet RLUSD. Issuer is
 * fixed (Ripple); we are *not* allowed to mint it, only to receive it.
 * `currency` is the 40-char hex form (XRPL wire requirement for codes
 * longer than 3 chars); wallets/explorers decode it back to `RLUSD`.
 */
const CHARGE_CURRENCY = RLUSD_TESTNET
const CHARGE_CURRENCY_LABEL = 'RLUSD'

/** Pricing per Anthropic token, denominated in RLUSD (USD-pegged). */
const RLUSD_PER_INPUT_TOKEN = 0.0001
const RLUSD_PER_OUTPUT_TOKEN = 0.0005

/** Trustline limit the recipient sets for RLUSD. */
const RECIPIENT_TRUSTLINE_LIMIT_RLUSD = '1000000'

/** Render a JS number as an XRPL IOU value string (15 sig digits max). */
function iouValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

function quoteRlusd(inputEstimate: number, maxOutputTokens: number): string {
  return iouValue(inputEstimate * RLUSD_PER_INPUT_TOKEN + maxOutputTokens * RLUSD_PER_OUTPUT_TOKEN)
}

function actualCostRlusd(inputTokens: number, outputTokens: number): string {
  return iouValue(inputTokens * RLUSD_PER_INPUT_TOKEN + outputTokens * RLUSD_PER_OUTPUT_TOKEN)
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

async function sendBuffered(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge, RLUSD-only billing, agent swaps XRP -> RLUSD)'])
  log.separator()

  try {
    createAnthropic()
  } catch (err: any) {
    log.error(err.message)
    process.exit(1)
  }

  // Single server-controlled wallet. Faucet-funded with XRP only -- it
  // never needs to hold RLUSD at boot, it only ever receives RLUSD.
  log.loading('Funding recipient wallet via testnet faucet...')
  const recipient = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Recipient (marketplace revenue)', recipient.address)
  log.wallet('RLUSD issuer (Ripple, testnet)', CHARGE_CURRENCY.issuer)
  log.info(`Charging currency: ${CHARGE_CURRENCY_LABEL} (real testnet RLUSD, not self-minted)`)
  log.info('Bootstrap asset for the client: native XRP (free from the testnet faucet)')
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price (RLUSD): ${RLUSD_PER_INPUT_TOKEN} ${CHARGE_CURRENCY_LABEL}/input-token, ` +
      `${RLUSD_PER_OUTPUT_TOKEN} ${CHARGE_CURRENCY_LABEL}/output-token`,
  )
  log.separator()

  // Recipient opens its RLUSD trustline. The client-side path resolver
  // requires the recipient's trustline to already exist when it runs
  // ripple_path_find for the first 402 -- otherwise the very first RLUSD
  // payment fails with PAYMENT_PATH_FAILED. No `enableTransfers` here:
  // Ripple already enabled asfDefaultRipple on the RLUSD issuer.
  log.loading(
    `Recipient accepts ${CHARGE_CURRENCY_LABEL} ` +
      `(trustline, limit ${RECIPIENT_TRUSTLINE_LIMIT_RLUSD})...`,
  )
  const recipientAccept = await recipient.acceptToken(CHARGE_CURRENCY, {
    network: NETWORK,
    limit: RECIPIENT_TRUSTLINE_LIMIT_RLUSD,
  })
  if ('hash' in recipientAccept && recipientAccept.hash) {
    log.tx(recipientAccept.hash, log.explorerLink(recipientAccept.hash))
  }
  log.success(`Recipient trustline status: ${recipientAccept.status}`)
  log.separator()

  const currencyJson = JSON.stringify(CHARGE_CURRENCY)

  // Single Mppx instance with a single xrpl/charge method bound to RLUSD.
  // No multi-challenge: the 402 always lists exactly one acceptable
  // currency. The client has to make RLUSD show up in its account on its
  // own (by swapping XRP on the public DEX).
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [
      charge({
        recipient: recipient.address,
        currency: CHARGE_CURRENCY,
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
        // Identity probe ONLY: marketplace address, network, and model.
        // We deliberately do NOT advertise the charge currency, the
        // issuer, the per-call price, or the XRP/RLUSD AMM pool. The
        // client learns *which token* it owes and *how much* exclusively
        // from the 402 challenge on /complete, and must discover the
        // liquidity to source that token entirely on its own.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            recipient: recipient.address,
            network: NETWORK,
            model: MODEL,
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
        const quote = quoteRlusd(inputEstimate, maxTokens)

        log.request(
          'POST',
          '/complete',
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        const handler = mppx['xrpl/charge']({
          recipient: recipient.address,
          amount: quote,
          currency: currencyJson,
        })
        const result = await handler(toWebRequest(req, raw))

        if (result.status === 402) {
          log.challenge(
            `Quote: ~${inputEstimate}in × ${RLUSD_PER_INPUT_TOKEN} + ${maxTokens}out × ` +
              `${RLUSD_PER_OUTPUT_TOKEN} = ${quote} ${CHARGE_CURRENCY_LABEL}`,
          )
          log.response(402, `single-challenge sent (${CHARGE_CURRENCY_LABEL} only)`)
          await sendBuffered(result.challenge as Response, res)
          return
        }

        // 200 -- the credential's Payment delivered the right amount of
        // RLUSD to recipient. Read it back just to log the amount.
        const credential = Credential.fromRequest(toWebRequest(req, raw))
        const chalReq = credential.challenge.request as Record<string, unknown>
        const paidAmount = String(chalReq.amount ?? '')

        callCount++
        log.verify(
          `RLUSD Payment validated on-chain (call #${callCount}, ` +
            `paid ${paidAmount} ${CHARGE_CURRENCY_LABEL})`,
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
              const real = actualCostRlusd(inputTokens, outputTokens)
              const overpayment = iouValue(Number(paidAmount) - Number(real))
              enqueueEvent('done', {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                actual_cost: real,
                paid: paidAmount,
                overpayment,
                currency_label: CHARGE_CURRENCY_LABEL,
              })
              log.success(
                `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} ${CHARGE_CURRENCY_LABEL} ` +
                  `real (paid ${paidAmount}, +${overpayment} overpay)`,
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
      'GET  /info        -> recipient, RLUSD issuer + identifier',
      'POST /complete    -> { prompt, maxTokens }',
      `                     -> 402 with ONE challenge in ${CHARGE_CURRENCY_LABEL} (no XRP option)`,
      '                     -> agent must swap XRP->RLUSD on the public testnet DEX,',
      '                        then retry with credential -> SSE token stream',
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
