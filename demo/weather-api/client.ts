/**
 * Weather API (IOU charge) -- Client
 *
 * A consumer of a premium weather API that, instead of an API key or
 * monthly subscription, bills every call as an on-chain micropayment in
 * the API's own token (`WTH`). The client holds **no client-side price
 * table**: it just POSTs /forecast with `{ city }`. The marketplace
 * decides the quote and ships it inside the 402 challenge; mppx parses
 * it and we surface the (amount, currency) pair via the `onProgress`
 * hook before the payment is signed. Same pattern as
 * `../llm-marketplace/charge-iou/` -- the only number the client picks
 * is *which city*.
 *
 *   Traditional SaaS API:   Authorization: Bearer sk-... + invoice end of month
 *   This API:               HTTP 402 -> WTH on-chain -> 200 + forecast
 *
 * Bootstrap (one-time, before any paid call):
 *   1. Fund a fresh wallet via the XRPL testnet faucet (XRP for the
 *      trustline reserve and tx fees -- not what we're paying *with*).
 *   2. GET /info to discover marketplace address and IOU currency
 *      identifier. The endpoint does NOT advertise per-call pricing.
 *   3. Open a trustline to the issuer (acceptToken / TrustSet) so the
 *      payer can hold and spend WTH.
 *   4. POST /faucet-iou to receive the demo allowance (10 WTH).
 *      Demo-only bootstrap; in production this would be a paid top-up
 *      (card payment, DEX swap, fiat on-ramp, ...).
 *
 * Then for each city in CITIES we POST /forecast. mppx intercepts the
 * 402, the `onProgress` hook logs the price the marketplace just
 * announced, signs an IOU `Payment` for that exact amount, submits to
 * XRPL, polls until validated, and retries the request transparently.
 *
 * Run: npx tsx demo/weather-api/client.ts
 *      (after `npx tsx demo/weather-api/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../../sdk/src/client/fetch.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import { formatAmount } from '../llm-marketplace/shared/format.js'
import * as log from '../log.js'

const PORT = 3007
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const rawFetch = globalThis.fetch

/**
 * The cities to query. Edit this list to exercise more or fewer paid
 * calls. The server only knows about its built-in `KNOWN_CITIES`; any
 * other name will still bill and return a deterministic mock forecast.
 */
const CITIES = ['Chamonix', 'Verbier', 'Zermatt']

type Forecast = {
  city: string
  date: string
  temperature_c: number
  condition: string
  wind_kmh: number
  fresh_snow_cm: number
  visibility_km: number
  premium_advice: string
}

/**
 * `/info` carries identity + token descriptor only. No `pricePerCallWth`
 * here: the price is announced per call inside the 402 challenge.
 *   - `currency` is "which token" (needed to open the trustline)
 *   - `faucetAllowanceWth` is the bootstrap top-up size (not a per-call price)
 */
type Info = {
  issuer: string
  recipient: string
  network: string
  currency: { currency: string; issuer: string }
  faucetAllowanceWth: string
  payerTrustlineLimitWth: string
  knownCities: string[]
}

/** Per-call quote learned from the 402 challenge (mppx onProgress). */
type Quote = { recipient: string; amount: string; currency: string }

type CallRecord = {
  city: string
  /** Amount paid for this call, learned from the 402 (not from a local table). */
  pricePaidWth: string
  txHash: string
  forecast: Forecast | null
  error?: string
}

async function fetchInfo(): Promise<Info> {
  const res = await rawFetch(`${BASE}/info`)
  if (!res.ok) throw new Error(`/info failed: ${res.status}`)
  return (await res.json()) as Info
}

/**
 * Verify that the IOU descriptor announced by a 402 challenge matches
 * the one we discovered via `/info` and opened a trustline to.
 *
 * On XRPL, an IOU is uniquely identified by the (currency, issuer)
 * pair. The 3-char symbol alone is not enough -- any account can issue
 * an IOU called "WTH". If the marketplace announces a different
 * issuer at quote time, either the server is misconfigured or it is
 * trying to redirect payment to a token we did not trustline (worst
 * case: a worthless lookalike). Either way we abort before mppx signs
 * anything.
 */
function assertIouMatches(
  wireCurrency: string,
  expected: { currency: string; issuer: string },
): void {
  let parsed: { currency?: unknown; issuer?: unknown }
  try {
    parsed = JSON.parse(wireCurrency)
  } catch {
    log.error(`402 currency is not a JSON IOU descriptor: ${wireCurrency}`)
    process.exit(1)
  }
  if (typeof parsed.currency !== 'string' || typeof parsed.issuer !== 'string') {
    log.error(`402 currency is missing currency/issuer fields: ${wireCurrency}`)
    process.exit(1)
  }
  if (parsed.currency !== expected.currency || parsed.issuer !== expected.issuer) {
    log.error(
      `402 announces IOU (${parsed.currency}, issuer ${parsed.issuer.slice(0, 6)}...${parsed.issuer.slice(-4)}) ` +
        `but /info advertised (${expected.currency}, issuer ${expected.issuer.slice(0, 6)}...${expected.issuer.slice(-4)}). ` +
        `Refusing to pay -- this is not the token we trustlined.`,
    )
    process.exit(1)
  }
}

async function fetchFaucetIou(holder: string): Promise<{ txHash: string }> {
  const res = await rawFetch(`${BASE}/faucet-iou`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder }),
  })
  if (!res.ok) throw new Error(`/faucet-iou failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { txHash: string }
  return { txHash: json.txHash }
}

/**
 * Call /forecast for a single city. mppx intercepts the 402 silently:
 * reads the WTH challenge, signs an IOU Payment, submits to XRPL, retries
 * the request once the tx is validated. The price is announced by the
 * server inside the 402 -- the client never advertises it.
 *
 * `lastQuote` is a ref into the captured-from-onProgress quote so we
 * can stash the paid amount in the call record after the request returns.
 */
async function getForecast(city: string, lastQuote: { value: Quote | null }): Promise<CallRecord> {
  log.loading(`GET forecast("${city}") -- mppx will auto-pay the quote from the 402...`)
  const response = await fetch(`${BASE}/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    log.error(`Request failed: ${response.status} ${errText}`)
    return {
      city,
      pricePaidWth: '0',
      txHash: '',
      forecast: null,
      error: `${response.status} ${errText}`,
    }
  }

  let txHash = ''
  try {
    const receipt = Receipt.fromResponse(response)
    txHash = receipt.reference
    log.tx(txHash, log.explorerLink(txHash))
  } catch {
    // No receipt header -- continue, just lose the explorer link.
  }

  const forecast = (await response.json()) as Forecast
  log.success(
    `Forecast for ${city}: ${forecast.temperature_c}°C, ${forecast.condition}, ` +
      `wind ${forecast.wind_kmh} km/h, fresh snow ${forecast.fresh_snow_cm} cm, ` +
      `visibility ${forecast.visibility_km} km`,
  )
  log.info(`  Premium advice: ${forecast.premium_advice}`)
  return {
    city,
    pricePaidWth: lastQuote.value?.amount ?? '0',
    txHash,
    forecast,
  }
}

async function main() {
  log.box(['XRPL MPP -- Weather API client (no API key, pay per call in WTH)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer', wallet.address)
  log.separator()

  log.loading(`Discovering API at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('API issuer (treasury)', info.issuer)
  log.wallet('API recipient (revenue)', info.recipient)
  log.info(
    `Currency: ${info.currency.currency} (issuer ${info.currency.issuer.slice(0, 6)}...${info.currency.issuer.slice(-4)})`,
  )
  log.info('Per-call price: not advertised here -- will arrive in the 402 on /forecast')
  log.info(`Known cities: ${info.knownCities.join(', ')}`)
  log.separator()

  // TrustSet from the payer toward the issuer. Without this the payer
  // cannot hold or transfer WTH, and the very first 402 fails at
  // preflight with PAYMENT_PATH_FAILED.
  log.loading(
    `Opening trustline: payer accepts up to ${info.payerTrustlineLimitWth} ${info.currency.currency}...`,
  )
  const accept = await wallet.acceptToken(info.currency, {
    network: NETWORK,
    limit: info.payerTrustlineLimitWth,
  })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.success(`Trustline status: ${accept.status}`)
  log.separator()

  log.loading(
    `Requesting demo allowance from /faucet-iou (${info.faucetAllowanceWth} ${info.currency.currency})...`,
  )
  const faucetIou = await fetchFaucetIou(wallet.address)
  log.tx(faucetIou.txHash, log.explorerLink(faucetIou.txHash))
  log.success(`Payer credited with ${info.faucetAllowanceWth} ${info.currency.currency}`)
  log.separator()

  // Capture the 402 quote so we can log what the marketplace just asked
  // for, before mppx signs anything. This is the *first* moment the
  // client knows what each specific call costs.
  const lastQuote: { value: Quote | null } = { value: null }

  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  Mppx.create({
    methods: [
      charge({
        wallet,
        mode: 'pull',
        network: NETWORK,
        onProgress: (evt) => {
          if (evt.type === 'challenge') {
            // Security check: the 402 declares the IOU as a JSON
            // (currency, issuer) pair. On XRPL anyone can issue an
            // IOU called "WTH" -- only the (symbol, issuer) pair is
            // unique. We refuse to pay if the marketplace tries to
            // bill us in a "WTH" issued by anyone other than the one
            // we discovered via /info and opened a trustline to.
            assertIouMatches(evt.currency, info.currency)

            lastQuote.value = {
              recipient: evt.recipient,
              amount: evt.amount,
              currency: evt.currency,
            }
            log.challenge(
              `402 received -- price: ${formatAmount(evt.amount, evt.currency, info.currency.currency)}`,
            )
            log.info(`Payable to: ${evt.recipient}`)
          } else if (evt.type === 'signing') {
            log.info('Signing the IOU Payment tx with the quoted amount...')
          } else if (evt.type === 'confirmed') {
            log.info(`Tx submitted: ${evt.hash}`)
          }
        },
      }),
    ],
  })

  log.box([
    'Querying the API',
    '',
    `Cities to fetch: ${CITIES.join(', ')}`,
    'Each call costs whatever the 402 announces (one IOU Payment tx on XRPL).',
  ])
  log.separator()

  const calls: CallRecord[] = []
  for (const city of CITIES) {
    const record = await getForecast(city, lastQuote)
    calls.push(record)
    log.separator()
  }

  const successful = calls.filter((c) => !c.error)
  const totalSpent = successful.reduce((acc, c) => acc + Number(c.pricePaidWth), 0)
  const remaining = Number(info.faucetAllowanceWth) - totalSpent

  const perCall = calls.map(
    (c, i) =>
      `  #${i + 1}  ${c.city.padEnd(14)}  ${c.pricePaidWth} ${info.currency.currency}  ` +
      (c.txHash ? `tx ${c.txHash.slice(0, 12)}...` : c.error ? `error: ${c.error}` : 'no tx'),
  )

  log.box([
    'Settlement -- weather-api (IOU charge)',
    '',
    `Currency:                ${info.currency.currency} (issuer ${info.currency.issuer.slice(0, 6)}...)`,
    `Calls made:              ${calls.length} (${successful.length} succeeded)`,
    '',
    'Per-call breakdown (price learned from each 402):',
    ...perCall,
    '',
    `Total spent:             ${totalSpent} ${info.currency.currency}`,
    `Initial allowance:       ${info.faucetAllowanceWth} ${info.currency.currency}`,
    `Remaining balance:       ${remaining} ${info.currency.currency}`,
    '',
    `On-chain footprint:      ${successful.length} IOU Payment tx (one per API call, charge mode)`,
    'Setup footprint (once):  1 TrustSet (payer) + 1 issuance (API -> payer)',
    '',
    'No API key, no signup, no monthly bill -- the request itself carries',
    'the payment and the receipt arrives in the response headers.',
    'Price discovery: the 402 challenge -- no client-side price table.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
