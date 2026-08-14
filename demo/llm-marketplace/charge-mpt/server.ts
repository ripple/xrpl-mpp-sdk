/**
 * LLM Marketplace -- Charge mode (MPT) -- Server
 *
 * Same wire flow as ../charge/ and ../charge-iou/, but per-prompt
 * billing is denominated in a **Multi-Purpose Token (MPT)** called
 * `CRED` (compute credits) instead of native XRP or an IOU. The MPP
 * wire protocol does not change -- only the currency carried on the
 * 402 challenge and on the `Payment` tx the client signs.
 *
 * Why MPT for an LLM marketplace?
 *
 *   MPTs are the XRPL primitive purpose-built for SaaS-style prepaid
 *   credits: the issuer has a fixed cap (`maximumAmount`), an
 *   immutable transferability flag, and an optional allowlist
 *   (`requireAuthorization`) so the marketplace controls who can hold
 *   the token. There are no trustline reserves on the holder side --
 *   each MPT holding is a single owner object, identified by an
 *   issuance id (a 64-char hex string) rather than a 3-char currency
 *   code + issuer pair. Think "OpenAI-style metered credits with the
 *   ledger moved on-chain".
 *
 * Marketplace setup (two server-controlled wallets):
 *   - issuer    -- mints the `CRED` MPT issuance with
 *                  `requireAuthorization: true` (allowlist) and
 *                  `allowTransfer: true` (required for paid transfers).
 *                  We own its seed so the demo bootstraps itself.
 *   - recipient -- receives every per-prompt MPT payment. Calls
 *                  `acceptToken(mpt)` then the issuer authorises it,
 *                  eagerly at boot, so the first 402 lands without
 *                  `MPT_NOT_AUTHORIZED`.
 *
 * Per /complete request (identical economic shape to ../charge/):
 *   1. Read prompt + maxTokens from the body
 *   2. Estimate input tokens locally, quote =
 *        (est × CREDITS_PER_INPUT_TOKEN) + (maxTokens × CREDITS_PER_OUTPUT_TOKEN)
 *   3. Issue an HTTP 402 challenge for that exact amount in CRED
 *      (one MPT Payment tx on XRPL)
 *   4. Once validated on-chain, call Anthropic with streaming and
 *      forward each token delta as an SSE `event: token`
 *   5. After Anthropic returns its usage report, emit `event: done`
 *      with the real cost vs the worst-case quote
 *
 * Run: npx tsx demo/llm-marketplace/charge-mpt/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../../../sdk/src/server/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { demoSecretKey } from '../../secret.js'
import { createAnthropic, estimateInputTokens, MODEL } from '../shared/anthropic.js'

const PORT = 3009
const NETWORK = 'testnet' as const

/**
 * Human-readable label for log lines. The MPT itself is identified on
 * the wire by its `mpt_issuance_id` -- there's no 3-char currency code
 * like with IOUs.
 */
const TOKEN_LABEL = 'CRED'

/**
 * MPT pricing in raw credit units per token. We mint the MPT with
 * `assetScale: 0` so every wire amount is a plain integer (1 = 1
 * credit). At 1 input + 5 output per LLM token, a typical 50-in /
 * 60-out call burns 350 credits, well within the 10 000 demo
 * allowance below.
 */
const CREDITS_PER_INPUT_TOKEN = 1
const CREDITS_PER_OUTPUT_TOKEN = 5

/** Initial CRED allowance handed out by /faucet-mpt. Demo-only bootstrap. */
const FAUCET_ALLOWANCE_CREDITS = 10_000

/** Hard cap on the MPT issuance. Plenty for the demo, dwarfed by the protocol max. */
const MAX_SUPPLY_CREDITS = '1000000'

function quoteCredits(inputEstimate: number, maxOutputTokens: number): number {
  return inputEstimate * CREDITS_PER_INPUT_TOKEN + maxOutputTokens * CREDITS_PER_OUTPUT_TOKEN
}

function actualCostCredits(inputTokens: number, outputTokens: number): number {
  return inputTokens * CREDITS_PER_INPUT_TOKEN + outputTokens * CREDITS_PER_OUTPUT_TOKEN
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
  log.box(['XRPL MPP -- LLM Marketplace (charge, MPT credits billing)'])
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
  log.wallet('Issuer (MPT treasury)', issuer.address)
  log.wallet('Recipient (marketplace)', recipient.address)
  log.separator()

  // Mint the MPT issuance. `allowTransfer: true` is mandatory for any
  // pay-per-X use case -- without it holders could only transfer back
  // to the issuer. `requireAuthorization: true` turns the issuance
  // into an allowlist: the marketplace gets to decide who can hold
  // credits, mirroring how prepaid SaaS APIs gate access today.
  log.loading(
    `Creating MPT issuance: ${TOKEN_LABEL} ` +
      `(allowTransfer, requireAuthorization, max ${MAX_SUPPLY_CREDITS})...`,
  )
  const { mpt, hash: createHash } = await issuer.createToken({
    assetScale: 0,
    maximumAmount: MAX_SUPPLY_CREDITS,
    allowTransfer: true,
    requireAuthorization: true,
    metadata: {
      name: TOKEN_LABEL,
      description: 'LLM marketplace inference credits (1 CRED = 1 unit of compute)',
      see: 'https://mpp.dev',
    },
    network: NETWORK,
  })
  log.tx(createHash, log.explorerLink(createHash))
  log.key('MPTokenIssuanceID', mpt.mpt_issuance_id)
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price: ${CREDITS_PER_INPUT_TOKEN} ${TOKEN_LABEL}/input-token, ` +
      `${CREDITS_PER_OUTPUT_TOKEN} ${TOKEN_LABEL}/output-token`,
  )
  log.separator()

  // Recipient opts in to receive the MPT (holder-side MPTokenAuthorize).
  // Status will be `pending_authorization` because the issuance requires
  // the issuer's countersignature.
  log.loading(`Recipient opts in to ${TOKEN_LABEL} (holder-side MPTokenAuthorize)...`)
  const recipientAccept = await recipient.acceptToken(mpt, { network: NETWORK })
  if ('hash' in recipientAccept && recipientAccept.hash) {
    log.tx(recipientAccept.hash, log.explorerLink(recipientAccept.hash))
  }
  log.info(`Recipient holder status: ${recipientAccept.status}`)

  // Issuer authorises the recipient (issuer-side MPTokenAuthorize with the
  // Holder field). Without this step the recipient cannot hold any balance
  // even though their MPToken object exists -- the first 402 would fail
  // with MPT_NOT_AUTHORIZED.
  log.loading(`Issuer authorises recipient on ${TOKEN_LABEL} (allowlist entry)...`)
  const authRecipient = await issuer.authorize(recipient.address, mpt, { network: NETWORK })
  log.tx(authRecipient.hash, log.explorerLink(authRecipient.hash))
  log.success(`Recipient ready to receive ${TOKEN_LABEL}`)
  log.separator()

  const mptJson = JSON.stringify(mpt)
  const store = Store.memory()
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [
      charge({
        recipient: recipient.address,
        currency: mpt,
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
        // Setup-only probe. We expose the MPT *identifier* (issuance id +
        // human label) because the client needs it to MPTokenAuthorize
        // before any MPT Payment can clear. That's "which token", not
        // "what it costs"; per-call price lives exclusively in the 402.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: issuer.address,
            recipient: recipient.address,
            network: NETWORK,
            token: { label: TOKEN_LABEL, ...mpt },
            model: MODEL,
            faucetAllowanceCredits: FAUCET_ALLOWANCE_CREDITS,
          }),
        )
        return
      }

      // Demo-only bootstrap. Two on-chain txs:
      //   1. Issuer authorises the (already-opted-in) holder. This is the
      //      allowlist entry -- in production it would be gated behind KYC,
      //      a paid subscription, an invite code, etc.
      //   2. Issuer issues the demo allowance to the holder.
      // In production the second step would be replaced by a paid top-up
      // (card payment, DEX swap, fiat on-ramp) targeting the same MPT.
      if (method === 'POST' && path === '/faucet-mpt') {
        const raw = await readBody(req)
        const { holder } = JSON.parse(raw) as { holder: string }
        if (!holder) {
          res.writeHead(400)
          res.end('holder address required')
          return
        }
        log.request(method, path, `holder=${holder}`)

        log.loading(`Issuer authorises ${holder} on ${TOKEN_LABEL} (allowlist)...`)
        const authHolder = await issuer.authorize(holder, mpt, { network: NETWORK })
        log.tx(authHolder.hash, log.explorerLink(authHolder.hash))

        log.loading(`Issuing ${FAUCET_ALLOWANCE_CREDITS} ${TOKEN_LABEL} to ${holder}...`)
        const issued = await issuer.issue(holder, String(FAUCET_ALLOWANCE_CREDITS), mpt, {
          network: NETWORK,
        })
        log.tx(issued.hash, log.explorerLink(issued.hash))
        log.success(
          `Faucet OK -- holder authorised + credited with ${FAUCET_ALLOWANCE_CREDITS} ${TOKEN_LABEL}`,
        )

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            amount: FAUCET_ALLOWANCE_CREDITS,
            token: mpt,
            authorizeTxHash: authHolder.hash,
            issueTxHash: issued.hash,
          }),
        )
        return
      }

      if (method === 'POST' && path === '/complete') {
        const raw = await readBody(req)
        const { prompt, maxTokens } = JSON.parse(raw) as { prompt: string; maxTokens: number }
        const inputEstimate = estimateInputTokens(prompt)
        const cost = quoteCredits(inputEstimate, maxTokens)

        log.request(
          'POST',
          '/complete',
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        const handler = mppx['xrpl/charge']({
          recipient: recipient.address,
          amount: String(cost),
          currency: mptJson,
        })
        const result = await handler(toWebRequest(req, raw))

        if (result.status === 402) {
          log.challenge(
            `Quote: ~${inputEstimate}in × ${CREDITS_PER_INPUT_TOKEN} + ` +
              `${maxTokens}out × ${CREDITS_PER_OUTPUT_TOKEN} = ${cost} ${TOKEN_LABEL}`,
          )
          log.response(402, 'challenge sent')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        callCount++
        log.verify(`MPT Payment validated on-chain (call #${callCount})`)

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
              const real = actualCostCredits(inputTokens, outputTokens)
              enqueueEvent('done', {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                actual_cost: real,
                paid: cost,
                overpayment: cost - real,
                token_label: TOKEN_LABEL,
              })
              log.success(
                `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} ${TOKEN_LABEL} ` +
                  `real (paid ${cost}, +${cost - real} overpay)`,
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
      'GET  /info        -> issuer, recipient, MPT issuance id, model (no pricing -- see 402)',
      'POST /faucet-mpt  -> { holder } -> issuer authorises holder + issues 10 000 CRED',
      'POST /complete    -> { prompt, maxTokens } -> 402 quote in CRED -> SSE token stream',
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
