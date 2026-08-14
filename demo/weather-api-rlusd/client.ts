/**
 * Weather API (RLUSD charge) -- Client
 *
 * Consumer of the RLUSD-billed weather API. The client holds **no
 * client-side price table**: it just POSTs /forecast with `{ city }`.
 * The marketplace decides the quote and ships it inside the 402
 * challenge; mppx parses it and we surface the (amount, currency) pair
 * via the `onProgress` hook before the payment is signed. Same pattern
 * as `../llm-marketplace/charge-iou/` -- the only number the client
 * picks is *which city*.
 *
 * The payer wallet is loaded from `.env` (`PAYER_SEED`) instead of
 * being faucet-funded, because Ripple does not expose a programmatic
 * faucet for RLUSD -- the test wallet must already hold some.
 *
 *   Traditional SaaS API:   Authorization: Bearer sk-... + invoice end of month
 *   This API:               HTTP 402 -> RLUSD on-chain -> 200 + forecast
 *
 * Bootstrap (one-time, before any paid call):
 *   1. Load the payer wallet from `PAYER_SEED` in `.env`. The wallet
 *      must already hold:
 *        - ~10 XRP (for the trustline reserve + per-tx fees)
 *        - some testnet RLUSD (from https://tryrlusd.com or any
 *          account you fund yourself)
 *   2. GET /info to discover marketplace address and RLUSD currency
 *      identifier. The endpoint does NOT advertise per-call pricing.
 *   3. Open (or confirm) a trustline to the RLUSD issuer
 *      (`acceptToken` / TrustSet). Idempotent -- returns `unchanged`
 *      when the trustline already exists at the expected limit.
 *   4. Sanity-check that the payer holds any RLUSD at all and abort
 *      early with a clear pointer to the testnet faucet if it is zero.
 *      No "is balance >= N × price" check -- we don't know the price
 *      until the first 402 lands.
 *
 * Then for each city in CITIES we POST /forecast. mppx intercepts the
 * 402, the `onProgress` hook logs the price the marketplace just
 * announced, signs an RLUSD `Payment` for that exact amount, submits
 * to XRPL, polls until validated, and retries the request transparently.
 *
 * Run: npx tsx demo/weather-api-rlusd/client.ts
 *      (after `npx tsx demo/weather-api-rlusd/server.ts`)
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../../sdk/src/client/fetch.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import { formatAmount } from '../llm-marketplace/shared/format.js'
import * as log from '../log.js'

const HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(HERE, '.env') })

const PORT = 3010
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const rawFetch = globalThis.fetch

/**
 * Cities to query. Edit this list to exercise more or fewer paid calls.
 * The server only knows about its built-in KNOWN_CITIES; any other name
 * will still bill and return a deterministic mock forecast.
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
 * `/info` carries identity + token descriptor only. No `pricePerCallRlusd`
 * here: the price is announced per call inside the 402 challenge.
 *   - `currency` is "which token" (needed to open the trustline)
 *   - `currencyDisplay` is just a friendly label for log lines
 */
type Info = {
  recipient: string
  network: string
  currency: { currency: string; issuer: string }
  /** Human-readable name (e.g. `RLUSD`) for log lines. `currency.currency` is the 40-char hex wire form. */
  currencyDisplay: string
  payerTrustlineLimitRlusd: string
  knownCities: string[]
}

/** Per-call quote learned from the 402 challenge (mppx onProgress). */
type Quote = { recipient: string; amount: string; currency: string }

type CallRecord = {
  city: string
  /** Amount paid for this call, learned from the 402 (not from a local table). */
  pricePaidRlusd: string
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
 * pair. The 3- or 40-char symbol alone is not enough -- any account
 * can issue an IOU called "RLUSD". If the marketplace announces a
 * different issuer at quote time, either the server is misconfigured
 * or it is trying to redirect payment to a token we did not trustline
 * (worst case: a worthless lookalike). Either way we abort before
 * mppx signs anything.
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
      `402 announces IOU (${parsed.currency.slice(0, 8)}..., issuer ${parsed.issuer.slice(0, 6)}...${parsed.issuer.slice(-4)}) ` +
        `but /info advertised (${expected.currency.slice(0, 8)}..., issuer ${expected.issuer.slice(0, 6)}...${expected.issuer.slice(-4)}). ` +
        `Refusing to pay -- this is not the token we trustlined.`,
    )
    process.exit(1)
  }
}

/**
 * Load the payer wallet from PAYER_SEED. Required: this demo cannot
 * faucet RLUSD for you (Ripple does not expose a programmatic faucet).
 */
function loadPayer(): Wallet {
  const seed = process.env.PAYER_SEED
  if (!seed || seed.startsWith('sEd...')) {
    log.error('PAYER_SEED is missing or still the placeholder.')
    log.info('Copy demo/weather-api-rlusd/.env.example to .env and paste a testnet seed')
    log.info('whose address already holds some RLUSD (see https://tryrlusd.com).')
    process.exit(1)
  }
  return Wallet.fromSeed(seed)
}

/**
 * Call /forecast for a single city. mppx intercepts the 402 silently:
 * reads the RLUSD challenge, signs an IOU Payment, submits to XRPL,
 * retries the request once the tx is validated. The price is announced
 * by the server inside the 402 -- the client never advertises it.
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
      pricePaidRlusd: '0',
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
    pricePaidRlusd: lastQuote.value?.amount ?? '0',
    txHash,
    forecast,
  }
}

async function main() {
  log.box(['XRPL MPP -- Weather API client (pay per call in real testnet RLUSD)'])
  log.separator()

  const wallet = loadPayer()
  log.wallet('Payer (from PAYER_SEED)', wallet.address)
  log.separator()

  log.loading(`Discovering API at ${BASE}/info ...`)
  const info = await fetchInfo()
  const display = info.currencyDisplay
  log.wallet('API recipient (revenue)', info.recipient)
  log.info(
    `Currency: ${display} (issuer ${info.currency.issuer.slice(0, 6)}...${info.currency.issuer.slice(-4)})`,
  )
  log.info('Per-call price: not advertised here -- will arrive in the 402 on /forecast')
  log.info(`Known cities: ${info.knownCities.join(', ')}`)
  log.separator()

  // TrustSet from the payer toward the RLUSD issuer. Idempotent: if the
  // payer already has a trustline at this limit (the common case when
  // reusing a wallet that already holds RLUSD), this is a no-op.
  log.loading(
    `Confirming trustline: payer accepts up to ${info.payerTrustlineLimitRlusd} ${display}...`,
  )
  const accept = await wallet.acceptToken(info.currency, {
    network: NETWORK,
    limit: info.payerTrustlineLimitRlusd,
  })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.success(`Trustline status: ${accept.status}`)

  // Sanity-check that the payer holds *any* RLUSD before attempting a
  // paid call. We cannot compare against the per-call cost here -- the
  // price is unknown until the first 402 lands. If the balance is too
  // small for the actual quote, mppx will surface INSUFFICIENT_IOU_BALANCE
  // on the first request, which is the right place for that error.
  const holding = await wallet.holdsToken(info.currency, { network: NETWORK })
  const balance = holding && 'balance' in holding ? holding.balance : '0'
  log.info(`Payer ${display} balance: ${balance}`)
  if (Number(balance) <= 0) {
    log.error(`Payer holds 0 ${display} -- cannot run paid calls.`)
    log.info('Get testnet RLUSD from https://tryrlusd.com and re-run.')
    process.exit(1)
  }
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
            // (currency, issuer) pair. On XRPL, anyone can issue an
            // IOU called "RLUSD" -- only the (symbol, issuer) pair is
            // unique. We refuse to pay if the marketplace tries to
            // bill us in a "RLUSD" issued by anyone other than the
            // one we discovered via /info and opened a trustline to.
            assertIouMatches(evt.currency, info.currency)

            lastQuote.value = {
              recipient: evt.recipient,
              amount: evt.amount,
              currency: evt.currency,
            }
            log.challenge(
              `402 received -- price: ${formatAmount(evt.amount, evt.currency, display)}`,
            )
            log.info(`Payable to: ${evt.recipient}`)
          } else if (evt.type === 'signing') {
            log.info('Signing the RLUSD Payment tx with the quoted amount...')
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
  const totalSpent = successful.reduce((acc, c) => acc + Number(c.pricePaidRlusd), 0)

  // Re-read the on-chain balance so the settlement reflects reality
  // (the in-memory delta could disagree with the ledger if anything
  // off-script happened mid-run).
  const postHolding = await wallet.holdsToken(info.currency, { network: NETWORK })
  const remaining =
    postHolding && 'balance' in postHolding
      ? postHolding.balance
      : `~${Number(balance) - totalSpent}`

  const perCall = calls.map(
    (c, i) =>
      `  #${i + 1}  ${c.city.padEnd(14)}  ${c.pricePaidRlusd} ${display}  ` +
      (c.txHash ? `tx ${c.txHash.slice(0, 12)}...` : c.error ? `error: ${c.error}` : 'no tx'),
  )

  log.box([
    'Settlement -- weather-api-rlusd (RLUSD charge)',
    '',
    `Currency:                ${display} ` +
      `(issuer ${info.currency.issuer.slice(0, 6)}..., real testnet RLUSD)`,
    `Calls made:              ${calls.length} (${successful.length} succeeded)`,
    '',
    'Per-call breakdown (price learned from each 402):',
    ...perCall,
    '',
    `Total spent:             ${totalSpent} ${display}`,
    `Balance before:          ${balance} ${display}`,
    `Balance after (ledger):  ${remaining} ${display}`,
    '',
    `On-chain footprint:      ${successful.length} RLUSD Payment tx (one per API call, charge mode)`,
    `Setup footprint:         ${accept.status === 'unchanged' ? '0' : '1'} TrustSet (payer side)`,
    '',
    'No API key, no signup, no monthly bill -- the request itself carries',
    'the payment, denominated in a real USD-pegged stablecoin.',
    'Price discovery: the 402 challenge -- no client-side price table.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
