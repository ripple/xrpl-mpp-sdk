/**
 * LLM Marketplace -- Charge mode (single IOU, client must swap) -- Server
 *
 * The marketplace bills **exclusively in its own IOU** (`CRD` -- a 3-char
 * test "credit" token). There is no XRP option, no USD option -- the 402
 * carries one and only one `WWW-Authenticate: Payment` challenge, and it
 * is denominated in `CRD`.
 *
 * The twist (vs. ../charge-iou/): we *also* hand the client a USD-pegged
 * IOU via /faucet-usd so the agent starts with an asset that is NOT
 * accepted by the marketplace. The client has to discover this, swap
 * USD -> CRD on the testnet DEX (via the AMM seeded below), and only
 * THEN come back to /complete with a CRD credential. That swap is
 * entirely the client agent's responsibility -- the server doesn't know
 * (or care) where the CRD came from, as long as the on-chain Payment
 * delivers it to `recipient`.
 *
 * To make the swap actually settle on testnet (which has no organic
 * liquidity for a token we just minted), the server bootstraps a
 * USD/CRD AMM pool itself at boot. This uses the XRPL native AMM (XLS-30)
 * via xrpl.js `AMMCreate` -- equivalent to running, end-user side:
 *
 *   xrpl-up amm create \
 *     --asset USD/<issuer> --asset2 CRD/<issuer> \
 *     --amount 50000 --amount2 50000 \
 *     --trading-fee 500 --node testnet --seed <lp-seed>
 *
 * Server-controlled wallets:
 *   - issuer    -- mints `USD` *and* `CRD` (a single test issuer so the
 *                  whole demo bootstraps from two faucets calls).
 *                  Runs `enableTransfers` (asfDefaultRipple) so the
 *                  client can pay through it.
 *   - recipient -- collects every CRD payment. Opens a `CRD` trustline
 *                  to issuer eagerly so the first 402 lands cleanly.
 *   - lp        -- liquidity provider for the USD/CRD AMM pool. Trusts
 *                  both IOUs, gets seeded by the issuer, then submits
 *                  `AMMCreate` with a 1:1 ratio. The issuer cannot
 *                  create the AMM directly because an issuer has no
 *                  on-ledger balance of its own IOU.
 *
 * Run: npx tsx demo/llm-marketplace/charge-swap/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Credential, Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { Client } from 'xrpl'
import { XRPL_RPC_URLS } from '../../../sdk/src/constants.js'
import { charge } from '../../../sdk/src/server/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { demoSecretKey } from '../../secret.js'
import { createAnthropic, estimateInputTokens, MODEL } from '../shared/anthropic.js'

const PORT = 3011
const NETWORK = 'testnet' as const

/**
 * The IOU the marketplace charges in. 3-char ASCII so XRPL's native IOU
 * format applies (no hex encoding) and the explorer renders it
 * legibly. "CRD" stands for "credit" -- a marketplace-local stablecoin
 * analogue.
 */
const CRED_CODE = 'CRD'

/** USD-pegged IOU we hand out via /faucet-usd. Same issuer as CRD. */
const USD_CODE = 'USD'

/** Pricing per Anthropic token, denominated in CRD. */
const CRED_PER_INPUT_TOKEN = 0.0001
const CRED_PER_OUTPUT_TOKEN = 0.0005

/** Initial USD allowance handed out by /faucet-usd (demo bootstrap). */
const FAUCET_ALLOWANCE_USD = '10'

/** Trustline limit the recipient sets for CRD. */
const RECIPIENT_TRUSTLINE_LIMIT_CRD = '1000000'

/** Trustline limit suggested to the payer for USD and CRD. */
const PAYER_TRUSTLINE_LIMIT = '1000'

/** Initial IOU balances seeded to the LP so it can open the AMM pool. */
const LP_SEED_USD = '100000'
const LP_SEED_CRD = '100000'

/** Initial AMM pool depth (1:1 parity USD/CRD). */
const AMM_INITIAL_USD = '50000'
const AMM_INITIAL_CRD = '50000'

/**
 * AMM trading fee, in units of 1/100 000. 500 = 0.5%, which is what the
 * client will pay on top of the parity rate when it swaps.
 */
const AMM_TRADING_FEE = 500

/** Render a JS number as an XRPL IOU value string (15 sig digits max). */
function iouValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

function quoteCred(inputEstimate: number, maxOutputTokens: number): string {
  return iouValue(inputEstimate * CRED_PER_INPUT_TOKEN + maxOutputTokens * CRED_PER_OUTPUT_TOKEN)
}

function actualCostCred(inputTokens: number, outputTokens: number): string {
  return iouValue(inputTokens * CRED_PER_INPUT_TOKEN + outputTokens * CRED_PER_OUTPUT_TOKEN)
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

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge, IOU-only billing, agent swaps USD -> CRD)'])
  log.separator()

  try {
    createAnthropic()
  } catch (err: any) {
    log.error(err.message)
    process.exit(1)
  }

  log.loading('Funding issuer + recipient + LP wallets via testnet faucet (parallel)...')
  const [issuer, recipient, lp] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Issuer (USD + CRD treasury)', issuer.address)
  log.wallet('Recipient (marketplace)', recipient.address)
  log.wallet('LP (USD/CRD AMM)', lp.address)
  log.info(`Charging currency: ${CRED_CODE} (issued by ${issuer.address})`)
  log.info(`Bootstrap currency: ${USD_CODE} (issued by ${issuer.address})`)
  log.info(`Model: ${MODEL}`)
  log.info(
    `Price (CRD): ${CRED_PER_INPUT_TOKEN} ${CRED_CODE}/input-token, ` +
      `${CRED_PER_OUTPUT_TOKEN} ${CRED_CODE}/output-token`,
  )
  log.separator()

  const usd = { currency: USD_CODE, issuer: issuer.address }
  const cred = { currency: CRED_CODE, issuer: issuer.address }
  const credJson = JSON.stringify(cred)

  log.loading('Issuer enables transfers (asfDefaultRipple)...')
  const transfers = await issuer.enableTransfers({ network: NETWORK })
  log.tx(transfers.hash, log.explorerLink(transfers.hash))

  log.loading(
    `Trustlines: recipient accepts ${CRED_CODE}, LP accepts both ${USD_CODE} and ${CRED_CODE}...`,
  )
  const [recipientAccept, lpAcceptUsd, lpAcceptCred] = await Promise.all([
    recipient.acceptToken(cred, { network: NETWORK, limit: RECIPIENT_TRUSTLINE_LIMIT_CRD }),
    lp.acceptToken(usd, { network: NETWORK, limit: '10000000' }),
    lp.acceptToken(cred, { network: NETWORK, limit: '10000000' }),
  ])
  if ('hash' in recipientAccept && recipientAccept.hash) {
    log.tx(recipientAccept.hash, log.explorerLink(recipientAccept.hash))
  }
  if ('hash' in lpAcceptUsd && lpAcceptUsd.hash) {
    log.tx(lpAcceptUsd.hash, log.explorerLink(lpAcceptUsd.hash))
  }
  if ('hash' in lpAcceptCred && lpAcceptCred.hash) {
    log.tx(lpAcceptCred.hash, log.explorerLink(lpAcceptCred.hash))
  }
  log.success('All trustlines open')
  log.separator()

  log.loading(`Issuer credits LP with ${LP_SEED_USD} ${USD_CODE} + ${LP_SEED_CRD} ${CRED_CODE}...`)
  const [seedUsd, seedCred] = await Promise.all([
    issuer.issue(lp.address, LP_SEED_USD, usd, { network: NETWORK }),
    issuer.issue(lp.address, LP_SEED_CRD, cred, { network: NETWORK }),
  ])
  log.tx(seedUsd.hash, log.explorerLink(seedUsd.hash))
  log.tx(seedCred.hash, log.explorerLink(seedCred.hash))
  log.success(`LP holds ${LP_SEED_USD} ${USD_CODE} and ${LP_SEED_CRD} ${CRED_CODE}`)
  log.separator()

  // Open the USD/CRD AMM pool. AMMCreate is the only operation here that
  // still goes through a raw xrpl.Client -- AMM primitives are not yet
  // covered by the Wallet abstraction surface. The pool is what makes
  // ripple_path_find return a viable USD -> CRD route for the agent's
  // cross-currency self-payment.
  log.loading(
    `LP opens AMM pool ${AMM_INITIAL_USD} ${USD_CODE} : ${AMM_INITIAL_CRD} ${CRED_CODE} ` +
      `(trading fee ${AMM_TRADING_FEE / 1000}%)...`,
  )
  const xrpl = new Client(XRPL_RPC_URLS[NETWORK], { timeout: 60_000 })
  await xrpl.connect()
  let ammAccount: string | undefined
  try {
    const ammResult = await xrpl.submitAndWait(
      {
        TransactionType: 'AMMCreate',
        Account: lp.address,
        Amount: { currency: USD_CODE, issuer: issuer.address, value: AMM_INITIAL_USD },
        Amount2: { currency: CRED_CODE, issuer: issuer.address, value: AMM_INITIAL_CRD },
        TradingFee: AMM_TRADING_FEE,
      },
      { wallet: lp._xrplWallet },
    )
    const ammMeta = ammResult.result.meta as any
    if (ammMeta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(
        `AMMCreate failed: ${ammMeta?.TransactionResult ?? 'unknown'} ` +
          `(${ammResult.result.hash})`,
      )
    }
    log.tx(ammResult.result.hash, log.explorerLink(ammResult.result.hash))

    // Read back amm_info for our own boot log only -- the pool address
    // is NOT advertised to clients (see /info).
    const info = (await xrpl.request({
      command: 'amm_info',
      asset: { currency: USD_CODE, issuer: issuer.address },
      asset2: { currency: CRED_CODE, issuer: issuer.address },
    } as any)) as any
    ammAccount = info.result?.amm?.account
    log.success(`AMM pool live -- account ${ammAccount ?? '(unknown)'}`)
  } finally {
    await xrpl.disconnect()
  }
  log.separator()

  // Single Mppx instance with a single xrpl/charge method bound to CRD.
  // No multi-challenge here -- the 402 always lists exactly one
  // acceptable currency. The client has to make the asset show up in
  // its account on its own.
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [
      charge({
        recipient: recipient.address,
        currency: cred,
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
        // We expose the CRD identifier (which trustline to open) and the
        // USD identifier (which trustline the agent needs to *hold* its
        // bootstrap allowance). We deliberately do NOT advertise the AMM
        // pool address: in real-life conditions a marketplace doesn't tell
        // you where to find liquidity. The agent only learns the token
        // PAIR (it holds USD, it owes CRD) and must discover the pool
        // itself on-chain (amm_info by asset pair, or path-finding). We
        // also do not advertise the per-call price -- that arrives in the
        // 402.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            recipient: recipient.address,
            issuer: issuer.address,
            network: NETWORK,
            model: MODEL,
            chargeCurrency: cred,
            chargeCurrencyLabel: CRED_CODE,
            bootstrapCurrency: usd,
            bootstrapCurrencyLabel: USD_CODE,
            faucetAllowanceUsd: FAUCET_ALLOWANCE_USD,
            payerTrustlineLimit: PAYER_TRUSTLINE_LIMIT,
          }),
        )
        return
      }

      // Demo-only bootstrap: hand out USD (NOT CRD). The agent has to
      // turn this into CRD via the DEX before it can pay anything.
      if (method === 'POST' && path === '/faucet-usd') {
        const raw = await readBody(req)
        const { holder } = JSON.parse(raw) as { holder: string }
        if (!holder) {
          res.writeHead(400)
          res.end('holder address required')
          return
        }
        log.request(method, path, `holder=${holder}`)
        log.loading(`Issuing ${FAUCET_ALLOWANCE_USD} ${USD_CODE} to ${holder}...`)
        const issued = await issuer.issue(holder, FAUCET_ALLOWANCE_USD, usd, {
          network: NETWORK,
        })
        log.tx(issued.hash, log.explorerLink(issued.hash))
        log.success(
          `Faucet OK -- holder credited with ${FAUCET_ALLOWANCE_USD} ${USD_CODE} ` +
            '(NB: the marketplace will only accept CRD)',
        )
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            amount: FAUCET_ALLOWANCE_USD,
            currency: usd,
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
        const quote = quoteCred(inputEstimate, maxTokens)

        log.request(
          'POST',
          '/complete',
          `"${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}" maxTokens=${maxTokens}`,
        )

        const handler = mppx['xrpl/charge']({
          recipient: recipient.address,
          amount: quote,
          currency: credJson,
        })
        const result = await handler(toWebRequest(req, raw))

        if (result.status === 402) {
          log.challenge(
            `Quote: ~${inputEstimate}in × ${CRED_PER_INPUT_TOKEN} + ${maxTokens}out × ` +
              `${CRED_PER_OUTPUT_TOKEN} = ${quote} ${CRED_CODE}`,
          )
          log.response(402, `single-challenge sent (${CRED_CODE} only)`)
          await sendBuffered(result.challenge as Response, res)
          return
        }

        // 200 -- the credential's Payment delivered the right amount of
        // CRD to recipient. Read it back just to log the amount.
        const credential = Credential.fromRequest(toWebRequest(req, raw))
        const chalReq = credential.challenge.request as Record<string, unknown>
        const paidAmount = String(chalReq.amount ?? '')

        callCount++
        log.verify(
          `CRD Payment validated on-chain (call #${callCount}, paid ${paidAmount} ${CRED_CODE})`,
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
              const real = actualCostCred(inputTokens, outputTokens)
              const overpayment = iouValue(Number(paidAmount) - Number(real))
              enqueueEvent('done', {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                actual_cost: real,
                paid: paidAmount,
                overpayment,
                currency_label: CRED_CODE,
              })
              log.success(
                `Stream done: ${inputTokens}in + ${outputTokens}out -> ${real} ${CRED_CODE} ` +
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
      'GET  /info        -> issuer, recipient, CRD + USD identifiers',
      `POST /faucet-usd  -> { holder } -> issues ${FAUCET_ALLOWANCE_USD} ${USD_CODE} (demo bootstrap)`,
      'POST /complete    -> { prompt, maxTokens }',
      `                     -> 402 with ONE challenge in ${CRED_CODE} (no USD option)`,
      '                     -> agent must swap USD->CRD on the testnet DEX,',
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
