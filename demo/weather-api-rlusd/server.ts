/**
 * Weather API marketplace (RLUSD charge) -- Server
 *
 * Same pitch as `../weather-api/`, but the per-call charge is denominated
 * in **real testnet RLUSD** (Ripple's USD-pegged stablecoin) instead of
 * a marketplace-minted `WTH` token. The MPP wire protocol does not
 * change; only the currency on the 402 challenge and on the `Payment`
 * tx the client signs.
 *
 *   Traditional SaaS:  Authorization: Bearer sk-... + invoice end of month
 *   This server:       HTTP 402 -> 0.1 RLUSD on-chain -> 200 + forecast
 *
 * Why RLUSD instead of a self-minted IOU?
 *
 *   `../weather-api/` mints its own `WTH` to keep the demo self-contained
 *   (no external bootstrap, no manual faucet step). That works, but it
 *   ties the credit unit to a single marketplace. RLUSD is a real
 *   USD-pegged stablecoin issued by Ripple on testnet/mainnet -- using
 *   it here shows the *production* shape of the same flow: the API
 *   accepts a widely-held asset and never has to operate its own
 *   treasury.
 *
 * Marketplace setup (one server-controlled wallet):
 *   - recipient -- receives every per-call RLUSD payment. Opens a
 *                  trustline to the RLUSD testnet issuer
 *                  (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`) eagerly at boot
 *                  so the very first 402 lands without
 *                  `PAYMENT_PATH_FAILED`. Loaded from `RECIPIENT_SEED`
 *                  if set, otherwise auto-funded from the XRPL testnet
 *                  faucet for an ephemeral demo run.
 *   - (no issuer) -- Ripple operates the RLUSD issuer; nothing for us
 *                    to mint or configure. There is no `/faucet-iou`
 *                    endpoint -- the payer brings their own RLUSD.
 *
 * Endpoints:
 *   GET  /info        -> { recipient, currency, knownCities, ... }  (no pricing)
 *   POST /forecast    -> body { city } -> 402 (0.1 RLUSD) -> 200 { forecast }
 *
 * Price discovery is server-side only: the client has no upfront price
 * table and `/info` does not advertise per-call pricing. Everything
 * monetary lives in the 402 challenge.
 *
 * Run: npx tsx demo/weather-api-rlusd/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { RLUSD_TESTNET } from '../../sdk/src/constants.js'
import { charge } from '../../sdk/src/server/Charge.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import * as log from '../log.js'
import { demoSecretKey } from '../secret.js'

const HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(HERE, '.env') })

const PORT = 3010
const NETWORK = 'testnet' as const

/**
 * Currency = real testnet RLUSD. Issuer is fixed; we are *not* allowed to
 * mint it, only to receive it. The MPP charge handler takes this object
 * verbatim and uses it as the IOU descriptor for both the 402 challenge
 * and on-chain verification.
 *
 * `CURRENCY.currency` is the 40-char hex form (XRPL wire requirement for
 * codes longer than 3 chars). `CURRENCY_DISPLAY` is just for log lines.
 */
const CURRENCY = RLUSD_TESTNET
const CURRENCY_DISPLAY = 'RLUSD'

/** Per-call price for /forecast, in RLUSD. ~10 cents to keep numbers visible. */
const PRICE_PER_CALL_RLUSD = '0.1'

/** Trustline limit the recipient sets toward the RLUSD issuer. */
const RECIPIENT_TRUSTLINE_LIMIT_RLUSD = '1000000'

/** Trustline limit the server suggests the payer set toward the RLUSD issuer. */
const PAYER_TRUSTLINE_LIMIT_RLUSD = '1000'

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
 * Deterministic mock forecast keyed off the city name. Identical to the
 * `../weather-api/` variant -- only the billing currency differs.
 */
function mockForecast(city: string): Forecast {
  const seed = [...city.toLowerCase()].reduce((a, c) => a + c.charCodeAt(0), 0)
  const conditions: Forecast['condition'][] = ['sunny', 'cloudy', 'snowing', 'rainy', 'foggy']
  const condition = conditions[seed % conditions.length]!
  const temperature_c = -8 + (seed % 18)
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

/**
 * Load the recipient wallet from RECIPIENT_SEED if present, otherwise
 * auto-fund a fresh testnet wallet. The recipient never needs RLUSD at
 * boot -- only XRP for the trustline reserve + fees.
 */
async function loadRecipient(): Promise<Wallet> {
  const seed = process.env.RECIPIENT_SEED
  if (seed) {
    log.info('RECIPIENT_SEED found in .env -- loading persistent recipient wallet')
    return Wallet.fromSeed(seed)
  }
  log.loading('No RECIPIENT_SEED set -- funding ephemeral recipient via testnet faucet...')
  return Wallet.fromFaucet({ network: NETWORK })
}

async function main() {
  log.box(['XRPL MPP -- Weather API marketplace (RLUSD charge, testnet)'])
  log.separator()

  const recipient = await loadRecipient()
  log.wallet('Recipient (API revenue)', recipient.address)
  log.wallet('RLUSD issuer (Ripple, testnet)', CURRENCY.issuer)
  log.info(`Currency: ${CURRENCY_DISPLAY} (real testnet RLUSD, not a self-minted IOU)`)
  log.info(`Price: ${PRICE_PER_CALL_RLUSD} ${CURRENCY_DISPLAY} per /forecast call`)
  log.separator()

  // Recipient opens a trustline to the RLUSD issuer. The client-side path
  // resolver requires the recipient's trustline to already exist when it
  // runs ripple_path_find for the first 402 -- otherwise the very first
  // RLUSD payment fails with PAYMENT_PATH_FAILED. Doing it eagerly at
  // boot also keeps /forecast latency consistent on the first call.
  //
  // Idempotent: returns `unchanged` if the trustline is already in place
  // at the same limit (handy when reusing a persistent RECIPIENT_SEED).
  log.loading(
    `Recipient accepts ${CURRENCY_DISPLAY} (trustline, limit ${RECIPIENT_TRUSTLINE_LIMIT_RLUSD})...`,
  )
  const recipientAccept = await recipient.acceptToken(CURRENCY, {
    network: NETWORK,
    limit: RECIPIENT_TRUSTLINE_LIMIT_RLUSD,
  })
  if ('hash' in recipientAccept && recipientAccept.hash) {
    log.tx(recipientAccept.hash, log.explorerLink(recipientAccept.hash))
  }
  log.success(`Recipient trustline status: ${recipientAccept.status}`)
  log.separator()

  const currencyJson = JSON.stringify(CURRENCY)
  const store = Store.memory()
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [
      charge({
        recipient: recipient.address,
        currency: CURRENCY,
        network: NETWORK,
        store,
        // Development only: process-local store, unsafe above one instance.
        storeDurability: 'process-local',
      }),
    ],
  })

  let callCount = 0
  let revenueRlusd = 0

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
            recipient: recipient.address,
            network: NETWORK,
            currency: CURRENCY,
            currencyDisplay: CURRENCY_DISPLAY,
            payerTrustlineLimitRlusd: PAYER_TRUSTLINE_LIMIT_RLUSD,
            knownCities: KNOWN_CITIES,
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
          amount: PRICE_PER_CALL_RLUSD,
          currency: currencyJson,
        })
        const result = await handler(toWebRequest(req, raw))
        if (result.status === 402) {
          log.challenge(`Price: ${PRICE_PER_CALL_RLUSD} ${CURRENCY_DISPLAY} (RLUSD Payment tx)`)
          log.response(402, 'challenge sent')
          await sendBuffered(result.challenge as Response, res)
          return
        }

        callCount++
        revenueRlusd += Number(PRICE_PER_CALL_RLUSD)
        log.verify(
          `RLUSD Payment validated -- call #${callCount}, ` +
            `cumulative revenue ${revenueRlusd.toFixed(2)} ${CURRENCY_DISPLAY}`,
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
      'GET  /info      -> recipient, RLUSD currency, known cities (no pricing)',
      'POST /forecast  -> { city } -> 402 (0.1 RLUSD) -> { forecast }',
      '',
      'Per-call price is carried by the 402 challenge -- the client never',
      'holds a price table.',
      '',
      'No /faucet-iou here -- the payer brings their own RLUSD (testnet faucet:',
      'https://tryrlusd.com).',
      '',
      'Waiting for a client to spend some RLUSD...',
    ])
    log.separator()
    log.server(`Listening on http://localhost:${PORT}`)
  })
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
