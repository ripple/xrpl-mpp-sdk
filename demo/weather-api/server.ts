/**
 * Weather API marketplace (IOU charge) -- Server
 *
 * A premium weather API that, instead of selling access via API keys or
 * monthly subscriptions, charges every call as an on-chain micropayment in
 * its own token (`WTH`). The pitch in one line:
 *
 *   Traditional SaaS:  Authorization: Bearer sk-... + invoice end of month
 *   This server:       HTTP 402 -> 1 WTH on-chain -> 200 + forecast
 *
 * This is the canonical prepaid-credits model many real APIs already use
 * (OpenAI tokens, Stripe credits, Twilio funds, ...), but with the credit
 * unit moved on-chain as a trustlined XRPL IOU. The marketplace controls
 * supply and metering; the holder spends what they bought. XRP would work
 * too but conflates "pay for compute" with "speculate on the underlying
 * asset" -- the IOU separates the two cleanly.
 *
 * Marketplace setup (three XRPL accounts, all managed by this process):
 *   - issuer    -- mints the `WTH` (Weather Token) IOU. Sets asfDefaultRipple
 *                  so payers can settle payments through it.
 *   - recipient -- receives every per-call payment. Opens a trustline to the
 *                  issuer at boot so the client's IOU charge can land
 *                  (the path resolver requires this trustline to exist
 *                  *before* the first 402 is emitted).
 *   - (payer)   -- the API consumer; lives in client.ts.
 *
 * The split between issuer and recipient is deliberate: a real marketplace
 * would separate treasury (mints/sells/refunds credits) from production
 * (collects per-call revenue) so they can run on different keys, in
 * different security zones, without changing the wire protocol. Here we
 * just hold both in one process for an end-to-end demo.
 *
 * Endpoints:
 *   GET  /info        -> { issuer, recipient, currency, knownCities, ... }  (no pricing)
 *   POST /faucet-iou  -> { holder } -> issues 10 WTH (demo bootstrap;
 *                        in production users would buy credits with a card)
 *   POST /forecast    -> body { city } -> 402 (1 WTH) -> 200 { forecast }
 *
 * Price discovery is server-side only: the client has no upfront price
 * table and `/info` does not advertise per-call pricing. Everything
 * monetary lives in the 402 challenge.
 *
 * Run: npx tsx demo/weather-api/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../../sdk/src/server/Charge.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import * as log from '../log.js'
import { demoSecretKey } from '../secret.js'

const PORT = 3007
const NETWORK = 'testnet' as const

/** Currency code -- 3 ASCII chars, native XRPL IOU format. */
const CURRENCY_CODE = 'WTH'

/** Per-call price for /forecast, in WTH. Fixed unit price -- no quoting. */
const PRICE_PER_CALL_WTH = '1'

/** Initial WTH allowance handed out by /faucet-iou. Demo-only bootstrap. */
const FAUCET_ALLOWANCE_WTH = '10'

/** Trustline limit the recipient sets toward the issuer. */
const RECIPIENT_TRUSTLINE_LIMIT_WTH = '1000000'

/** Trustline limit the server suggests the payer set toward the issuer. */
const PAYER_TRUSTLINE_LIMIT_WTH = '1000'

/** A canonical city list -- the agent only knows about these. */
const KNOWN_CITIES = [
  'Chamonix',
  'Verbier',
  'Zermatt',
  'Val Thorens',
  'Megève',
  'Tignes',
  'Courchevel',
  'Saint-Moritz',
] as const

type Forecast = {
  city: string
  date: string
  temperature_c: number
  condition: 'sunny' | 'cloudy' | 'snowing' | 'rainy' | 'foggy'
  wind_kmh: number
  fresh_snow_cm: number
  visibility_km: number
  premium_advice: string
}

/**
 * Deterministic mock forecast keyed off the city name. Good enough to make
 * the agent's reasoning visible: results don't change between runs for the
 * same city, but vary enough across cities that comparing them is meaningful.
 */
function mockForecast(city: string): Forecast {
  const seed = [...city.toLowerCase()].reduce((a, c) => a + c.charCodeAt(0), 0)
  const conditions: Forecast['condition'][] = ['sunny', 'cloudy', 'snowing', 'rainy', 'foggy']
  const condition = conditions[seed % conditions.length]!
  const temperature_c = -8 + (seed % 18) // -8 .. +9 °C, ski-resort plausible
  const wind_kmh = 5 + ((seed * 7) % 40)
  const fresh_snow_cm = condition === 'snowing' ? 5 + (seed % 35) : seed % 6
  const visibility_km = condition === 'foggy' ? 0.5 + (seed % 3) : 5 + (seed % 15)

  const adviceByCondition: Record<Forecast['condition'], string> = {
    sunny: 'Bluebird conditions, sunscreen mandatory. Bookings will be busy.',
    cloudy: 'Flat light on the upper slopes -- stick to tree runs.',
    snowing: 'Fresh powder forecast, lift queues will spike at opening.',
    rainy: 'Avoid lower-altitude pistes; rain may ice the runs overnight.',
    foggy: 'Visibility critical; off-piste not recommended today.',
  }

  return {
    city,
    date: new Date().toISOString().slice(0, 10),
    temperature_c,
    condition,
    wind_kmh,
    fresh_snow_cm,
    visibility_km,
    premium_advice: adviceByCondition[condition],
  }
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

async function main() {
  log.box(['XRPL MPP -- Weather API marketplace (IOU charge)'])
  log.separator()

  log.loading('Funding issuer + recipient wallets via testnet faucet (parallel)...')
  const [issuer, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Issuer (treasury)', issuer.address)
  log.wallet('Recipient (API)', recipient.address)
  log.info(`Currency: ${CURRENCY_CODE} issued by ${issuer.address}`)
  log.info(`Price: ${PRICE_PER_CALL_WTH} ${CURRENCY_CODE} per /forecast call`)
  log.separator()

  // Issuer must enable asfDefaultRipple so holders can pay through us.
  log.loading('Issuer enables transfers (asfDefaultRipple)...')
  const transfers = await issuer.enableTransfers({ network: NETWORK })
  log.tx(transfers.hash, log.explorerLink(transfers.hash))

  // Recipient opens a trustline to the issuer. The client-side path resolver
  // requires the recipient's trustline to already exist when it runs
  // ripple_path_find for the first 402 -- otherwise the very first IOU
  // payment fails with PAYMENT_PATH_FAILED. Doing it eagerly at boot
  // also keeps /forecast latency consistent on the first call.
  const currency = { currency: CURRENCY_CODE, issuer: issuer.address }
  log.loading(
    `Recipient accepts ${CURRENCY_CODE} (trustline, limit ${RECIPIENT_TRUSTLINE_LIMIT_WTH})...`,
  )
  const recipientAccept = await recipient.acceptToken(currency, {
    network: NETWORK,
    limit: RECIPIENT_TRUSTLINE_LIMIT_WTH,
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
  let revenueWth = 0

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/info') {
        // Identity + token descriptor only. No per-call price advertised:
        // the quote lives exclusively in the 402 challenge so the client
        // never holds a local price table. `currency` is still here
        // because the payer needs it to open the trustline -- that's
        // "which token", not "how much".
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: issuer.address,
            recipient: recipient.address,
            network: NETWORK,
            currency,
            faucetAllowanceWth: FAUCET_ALLOWANCE_WTH,
            payerTrustlineLimitWth: PAYER_TRUSTLINE_LIMIT_WTH,
            knownCities: KNOWN_CITIES,
          }),
        )
        return
      }

      // Demo-only bootstrap: hand out a tiny WTH allowance so the agent has
      // something to spend. In production this would be replaced by a paid
      // top-up (card payment, DEX swap, etc.).
      if (method === 'POST' && path === '/faucet-iou') {
        const raw = await readBody(req)
        const { holder } = JSON.parse(raw) as { holder: string }
        if (!holder) {
          res.writeHead(400)
          res.end('holder address required')
          return
        }
        log.request(method, path, `holder=${holder}`)
        log.loading(`Issuing ${FAUCET_ALLOWANCE_WTH} ${CURRENCY_CODE} to ${holder}...`)
        const issued = await issuer.issue(holder, FAUCET_ALLOWANCE_WTH, currency, {
          network: NETWORK,
        })
        log.tx(issued.hash, log.explorerLink(issued.hash))
        log.success(`Faucet OK -- holder credited with ${FAUCET_ALLOWANCE_WTH} ${CURRENCY_CODE}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            amount: FAUCET_ALLOWANCE_WTH,
            currency,
            txHash: issued.hash,
          }),
        )
        return
      }

      if (method === 'POST' && path === '/forecast') {
        const raw = await readBody(req)
        const { city } = JSON.parse(raw) as { city: string }
        log.request(method, path, `city="${city}"`)

        const handler = mppx['xrpl/charge']({
          recipient: recipient.address,
          amount: PRICE_PER_CALL_WTH,
          currency: currencyJson,
        })
        const result = await handler(toWebRequest(req, raw))

        if (result.status === 402) {
          log.challenge(`Price: ${PRICE_PER_CALL_WTH} ${CURRENCY_CODE} (IOU Payment tx)`)
          log.response(402, 'challenge sent')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        callCount++
        revenueWth += Number(PRICE_PER_CALL_WTH)
        log.verify(
          `IOU Payment validated -- call #${callCount}, ` +
            `cumulative revenue ${revenueWth} ${CURRENCY_CODE}`,
        )

        const forecast = mockForecast(city)
        const successResponse = result.withReceipt(Response.json(forecast)) as Response

        try {
          const receipt = Receipt.fromResponse(successResponse)
          log.tx(receipt.reference, log.explorerLink(receipt.reference))
        } catch {
          // No receipt header -- not fatal.
        }

        log.response(200, `forecast(${city}) delivered`)
        await sendBuffered(successResponse, res)
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
      'GET  /info        -> issuer, recipient, WTH currency, known cities (no pricing)',
      'POST /faucet-iou  -> { holder } -> issues 10 WTH (demo bootstrap)',
      'POST /forecast    -> { city }  -> 402 (1 WTH) -> { forecast }',
      '',
      'Per-call price is carried by the 402 challenge -- the client never',
      'holds a price table.',
      '',
      'Waiting for a client to spend some WTH...',
    ])
    log.separator()
    log.server(`Listening on http://localhost:${PORT}`)
  })
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
