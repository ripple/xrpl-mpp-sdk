/**
 * LLM Marketplace -- Charge mode (RLUSD, agent swaps XRP -> RLUSD) -- Client
 *
 * The marketplace's /complete endpoint replies with a 402 carrying ONE
 * `WWW-Authenticate: Payment` challenge. EVERYTHING monetary lives in
 * that challenge: the amount due, the token (currency code), and its
 * issuer. `GET /info` is a bare identity probe -- it returns only the
 * marketplace address, network, and model. It does NOT advertise the
 * currency, the issuer, or the price.
 *
 * So the client cannot even know *which token* it will be billed in
 * until it has triggered the 402. The flow is therefore:
 *
 *   1. POST /complete with no credential -> 402.
 *   2. Parse the challenge: learn amount + {currency, issuer} + recipient.
 *   3. Only now open the trustline toward that issuer (so we can hold it).
 *   4. We hold native XRP, not the token -> discover the public XRP/<token>
 *      AMM pool on-chain and swap just enough XRP for the amount due.
 *   5. Retry /complete with a credential signing a Payment of the token.
 *
 * The swap is a single cross-currency Payment from the agent to itself
 * (`Amount` in the token, `SendMax` in XRP drops); rippled path-finds the
 * public pool automatically. No wallet here -- not the agent's, not the
 * marketplace's -- is ever funded with the token. The only units of it
 * that exist in this demo are the ones the agent buys with faucet XRP.
 *
 * Run: npx tsx demo/llm-marketplace/charge-swap-rlusd/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge-swap-rlusd/server.ts`)
 */
import { Challenge, Receipt } from 'mppx'
import { Client, type Payment } from 'xrpl'
import { charge } from '../../../sdk/src/client/Charge.js'
import { XRPL_RPC_URLS } from '../../../sdk/src/constants.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { MODEL } from '../shared/anthropic.js'
import { decodeCurrencyCode, formatAmount } from '../shared/format.js'

const PORT = 3012
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const PROMPT = 'Explain in one short paragraph why agents need on-chain DEX access.'
const MAX_TOKENS = 120

/**
 * Trustline limit the payer sets for whatever token the 402 turns out to
 * ask for. This is a client-side risk choice, NOT something the
 * marketplace tells us -- /info no longer carries it.
 */
const PAYER_TRUSTLINE_LIMIT = '1000'

/**
 * Slippage cushion the agent adds on top of the AMM-quoted XRP cost.
 * 5% absorbs the trading fee (0.5%) + price drift between amm_info and
 * tx submission + drop rounding. The Payment carries `SendMax` so we
 * never overspend; this is just a permission band.
 */
const SLIPPAGE_PCT = 5

/** Bare identity probe -- no currency, no issuer, no price. */
type Info = {
  recipient: string
  network: string
  model: string
}

/** Token identity, derived entirely from the 402 challenge. */
type ChargeCurrency = { currency: string; issuer: string }

type ChargeRequest = {
  amount: string
  currency: string
  recipient: string
}

type ChargeChallenge = Challenge.Challenge<ChargeRequest, 'charge', 'xrpl'>

type DoneEvent = {
  input_tokens: number
  output_tokens: number
  actual_cost: string
  paid: string
  overpayment: string
  currency_label: string
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      sep = buffer.indexOf('\n\n')

      let event = 'message'
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data = line.slice(5).trim()
      }
      if (data) yield { event, data: JSON.parse(data) }
    }
  }
}

async function fetchInfo(): Promise<Info> {
  const res = await fetch(`${BASE}/info`)
  if (!res.ok) throw new Error(`/info failed: ${res.status}`)
  return (await res.json()) as Info
}

/** Render a JS number as an XRPL IOU value string (15 sig digits max). */
function iouValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

/** Render XRP drops (always an integer string for the wire). */
function dropsValue(value: number): string {
  return String(Math.ceil(value))
}

type AmmQuote = {
  /** XRP reserve in the AMM, in drops (string with full precision). */
  xrpReserveDrops: string
  /** Token reserve in the AMM. */
  tokenReserve: string
  /** Trading fee, units of 1/100 000 (e.g. 500 == 0.5%). */
  tradingFeeUnits: number
  /** XRP (in drops) needed to receive `requestedToken`, *before* slippage. */
  xrpDropsQuotedForRequest: string
}

/**
 * Read the public XRP/<token> AMM pool depth and compute the XRP-in
 * required to receive exactly `requestedToken` token-out, using the
 * constant-product invariant
 *
 *   (X + dx) * (Y - dy) = X * Y
 *
 * with X = XRP reserve (drops), Y = token reserve, dy = requestedToken.
 * The trading fee is taken on the *input* side, so:
 *
 *   dx_pre_fee = X * dy / (Y - dy)
 *   dx_after_fee = dx_pre_fee / (1 - fee)
 *
 * (matches rippled's AMM math; see XLS-30d).
 */
async function quoteSwap(
  xrpl: Client,
  chargeCurrency: ChargeCurrency,
  label: string,
  requestedToken: string,
): Promise<AmmQuote> {
  // The pool address is never advertised: we discover the pool purely
  // from the token PAIR we want to trade (XRP we hold, the token we owe).
  const ammInfo = (await xrpl.request({
    command: 'amm_info',
    asset: { currency: 'XRP' },
    asset2: chargeCurrency,
  } as any)) as any

  const a = ammInfo.result?.amm
  if (!a) throw new Error(`amm_info returned no AMM (XRP/${label} pool missing?)`)
  // The XRP side is a plain drops string; the token side is an object.
  // Pick by type so we are robust to asset/asset2 ordering.
  const sideA = a.amount
  const sideB = a.amount2
  const xrpSide = typeof sideA === 'string' ? sideA : sideB
  const tokenSide = typeof sideA === 'string' ? sideB : sideA
  const X = Number(xrpSide) // drops
  const Y = Number(tokenSide.value) // token
  const dy = Number(requestedToken)
  if (dy >= Y) {
    throw new Error(`Pool too shallow: want ${dy} ${label} but only ${Y} available.`)
  }
  const dxPreFee = (X * dy) / (Y - dy)
  // Trading fee comes from the on-chain pool itself, not from /info.
  const tradingFeeUnits = Number(a.trading_fee)
  const feeFraction = tradingFeeUnits / 100_000
  const dxAfterFee = dxPreFee / (1 - feeFraction)
  return {
    xrpReserveDrops: xrpSide,
    tokenReserve: tokenSide.value,
    tradingFeeUnits,
    xrpDropsQuotedForRequest: dropsValue(dxAfterFee),
  }
}

/** Read the wallet's balance of `currency` toward its issuer; '0' if none. */
async function readTokenBalance(wallet: Wallet, currency: ChargeCurrency): Promise<string> {
  const h = await wallet.holdsToken(currency, { network: NETWORK })
  if (h && 'balance' in h && h.balance) return h.balance
  return '0'
}

/**
 * Submit the actual swap. A cross-currency Payment from the agent to
 * itself: `Amount` is the exact token we want out, `SendMax` is the
 * agent's spend cap in XRP drops (quote + slippage). rippled discovers
 * the public XRP/<token> AMM via path-finding and executes the swap
 * atomically.
 */
async function swapXrpToToken(
  xrpl: Client,
  wallet: Wallet,
  chargeCurrency: ChargeCurrency,
  requestedToken: string,
  xrpDropsMax: string,
): Promise<{ hash: string; deliveredToken: string }> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: wallet.address,
    Amount: {
      currency: chargeCurrency.currency,
      issuer: chargeCurrency.issuer,
      value: requestedToken,
    },
    SendMax: xrpDropsMax,
  }

  const result = await xrpl.submitAndWait(tx, { wallet: wallet._xrplWallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `Swap failed: ${meta?.TransactionResult ?? 'unknown'} (hash ${result.result.hash})`,
    )
  }
  const delivered = meta.delivered_amount ?? meta.DeliveredAmount
  const deliveredToken =
    delivered && typeof delivered === 'object' && 'value' in delivered
      ? String(delivered.value)
      : requestedToken
  return { hash: result.result.hash, deliveredToken }
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, RLUSD, agent swaps XRP -> RLUSD)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet (XRP only)...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer (agent)', wallet.address)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('Marketplace recipient', info.recipient)
  log.info(`Model: ${info.model}`)
  log.info(
    'Note: /info carries NO currency, issuer, or price. ' +
      'We learn what we owe only from the 402.',
  )
  log.separator()

  // Configure the xrpl/charge SDK method now (it doesn't need the
  // currency yet -- that comes from the challenge when we build the
  // credential). The swap itself is a plain xrpl.js Payment.
  const chargeMethod = charge({
    wallet,
    mode: 'pull',
    network: NETWORK,
    onProgress: (evt) => {
      if (evt.type === 'preflight') log.info('Running preflight (balance/path checks)...')
      else if (evt.type === 'pathfinding') log.info('ripple_path_find (token only)...')
      else if (evt.type === 'signing') log.info('Signing the token Payment tx...')
      else if (evt.type === 'confirmed') log.info(`Tx submitted: ${evt.hash}`)
    },
  })

  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading(`POST ${BASE}/complete -- expecting a 402 that reveals the token + price...`)
  log.separator()

  const requestBody = JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS })

  // --- Round 1: trigger the 402. This is the FIRST time we learn the
  //     currency, the issuer, and the amount. ---
  const probe = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  })

  if (probe.status !== 402) {
    log.error(`Expected 402, got ${probe.status}: ${await probe.text()}`)
    process.exit(1)
  }

  const offers = Challenge.fromResponseList(probe) as ChargeChallenge[]
  if (offers.length !== 1) {
    log.error(`Expected exactly 1 challenge, got ${offers.length}`)
    process.exit(1)
  }
  const offer = offers[0]
  const requestedToken = offer.request.amount

  // Parse the token identity straight out of the challenge currency.
  const chargeCurrency = JSON.parse(offer.request.currency) as ChargeCurrency
  const label = decodeCurrencyCode(chargeCurrency.currency)

  log.challenge(
    `402 received -- payable in ${label} (issuer ` +
      `${chargeCurrency.issuer.slice(0, 6)}…${chargeCurrency.issuer.slice(-4)}): ` +
      `${formatAmount(requestedToken, offer.request.currency, label)}`,
  )
  log.info(`Token + issuer + amount all came from the 402, not /info.`)
  log.separator()

  // --- Only now do we open the trustline -- we couldn't, before the 402
  //     told us which token/issuer to trust. ---
  log.loading(
    `Opening trustline: payer accepts up to ${PAYER_TRUSTLINE_LIMIT} ${label} ` +
      `(toward ${chargeCurrency.issuer.slice(0, 6)}…${chargeCurrency.issuer.slice(-4)})...`,
  )
  const acceptToken = await wallet.acceptToken(chargeCurrency, {
    network: NETWORK,
    limit: PAYER_TRUSTLINE_LIMIT,
  })
  if ('hash' in acceptToken && acceptToken.hash) {
    log.tx(acceptToken.hash, log.explorerLink(acceptToken.hash))
  }
  log.success(`Trustline: ${label}=${acceptToken.status}`)
  log.separator()

  // Snapshot pre-swap balances.
  const [xrpBefore, tokenBefore] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    readTokenBalance(wallet, chargeCurrency),
  ])
  log.box([
    'Wallet balances (pre-swap)',
    '',
    `XRP:    ${xrpBefore} drops (${(Number(xrpBefore) / 1_000_000).toFixed(6)} XRP)`,
    `${label}:  ${tokenBefore} ${label}  ← 0 (cannot pay yet)`,
  ])
  log.info(
    `Current ${label} balance: ${tokenBefore}  →  short ${requestedToken}. ` +
      'A swap is required before we can honor this challenge.',
  )
  log.separator()

  // --- Quote the swap against the live public AMM. ---
  log.loading(`Querying public AMM pool XRP/${label} (amm_info)...`)
  const xrpl = new Client(XRPL_RPC_URLS[NETWORK], { timeout: 60_000 })
  await xrpl.connect()
  let swap: { hash: string; deliveredToken: string }
  let quote: AmmQuote
  try {
    quote = await quoteSwap(xrpl, chargeCurrency, label, requestedToken)
    const xrpDropsWithSlippage = dropsValue(
      Number(quote.xrpDropsQuotedForRequest) * (1 + SLIPPAGE_PCT / 100),
    )

    log.info(
      `AMM depth: ${(Number(quote.xrpReserveDrops) / 1_000_000).toFixed(2)} XRP : ` +
        `${quote.tokenReserve} ${label}  (fee ${quote.tradingFeeUnits / 1000}%)`,
    )
    log.info(
      `AMM quote for ${requestedToken} ${label}: ` +
        `${quote.xrpDropsQuotedForRequest} drops ` +
        `(${(Number(quote.xrpDropsQuotedForRequest) / 1_000_000).toFixed(6)} XRP, ` +
        'constant-product + fee).',
    )
    log.info(
      `SendMax with ${SLIPPAGE_PCT}% slippage band: ${xrpDropsWithSlippage} drops ` +
        `(${(Number(xrpDropsWithSlippage) / 1_000_000).toFixed(6)} XRP)`,
    )
    log.separator()

    log.loading(
      `Swapping ≤${(Number(xrpDropsWithSlippage) / 1_000_000).toFixed(6)} XRP for ` +
        `${requestedToken} ${label} ` +
        `(cross-currency Payment self -> self via public AMM)...`,
    )
    swap = await swapXrpToToken(xrpl, wallet, chargeCurrency, requestedToken, xrpDropsWithSlippage)
    log.tx(swap.hash, log.explorerLink(swap.hash))
    log.success(`Swap settled -- delivered ${swap.deliveredToken} ${label}`)
  } finally {
    await xrpl.disconnect()
  }

  const [xrpAfterSwap, tokenAfterSwap] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    readTokenBalance(wallet, chargeCurrency),
  ])
  const xrpSpentOnSwap = Number(xrpBefore) - Number(xrpAfterSwap)
  log.box([
    `Post-swap balances`,
    '',
    `XRP:    ${xrpAfterSwap} drops  (debited ${xrpSpentOnSwap} drops incl. tx fee)`,
    `${label}:  ${tokenAfterSwap} ${label}  (received ${swap.deliveredToken})`,
  ])
  log.separator()

  // --- Round 2: build the credential and retry /complete. ---
  log.loading(
    `Building credential for the ${label} challenge ` +
      `(${requestedToken} ${label} -> recipient)...`,
  )
  const credentialHeader = await chargeMethod.createCredential({
    challenge: offer,
    context: { mode: 'pull' },
  })

  log.loading(`POST ${BASE}/complete (with Authorization) -- server submits the tx...`)
  log.separator()
  const response = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: credentialHeader },
    body: requestBody,
  })

  if (!response.ok) {
    log.error(`Request failed: ${response.status} ${await response.text()}`)
    process.exit(1)
  }
  if (!response.body) {
    log.error('No response body')
    process.exit(1)
  }

  log.success(`Payment settled on-chain (paid in ${label})`)
  let paymentHash: string | undefined
  try {
    const receipt = Receipt.fromResponse(response)
    paymentHash = receipt.reference
    log.tx(receipt.reference, log.explorerLink(receipt.reference))
  } catch {
    // No Payment-Receipt header -- still safe to continue.
  }

  log.info('Streaming Anthropic tokens:')
  log.separator()
  process.stdout.write('   ')

  let done: DoneEvent | null = null
  for await (const evt of readSseEvents(response.body)) {
    if (evt.event === 'token') {
      process.stdout.write(evt.data.value)
    } else if (evt.event === 'done') {
      done = evt.data as DoneEvent
    } else if (evt.event === 'error') {
      process.stdout.write('\n')
      log.error(`Server stream error: ${evt.data.message}`)
      process.exit(1)
    }
  }
  process.stdout.write('\n')
  log.separator()

  if (!done) {
    log.error('Stream ended without a done event')
    process.exit(1)
  }

  const [xrpAfter, tokenAfter] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    readTokenBalance(wallet, chargeCurrency),
  ])

  const overpayPct =
    Number(done.paid) > 0
      ? ((Number(done.overpayment) / Number(done.paid)) * 100).toFixed(1)
      : '0.0'

  log.box([
    'Settlement -- charge (paid in RLUSD, agent sourced RLUSD via XRP swap)',
    '',
    `Server quote:        ${formatAmount(done.paid, offer.request.currency, label)} (from the 402)`,
    `Actual cost:         ${formatAmount(done.actual_cost, offer.request.currency, label)} (Anthropic usage report)`,
    `Overpayment:         ${formatAmount(done.overpayment, offer.request.currency, label)} (${overpayPct}%)`,
    '',
    `Anthropic usage:     ${done.input_tokens} input + ${done.output_tokens} output tokens (${MODEL})`,
    '',
    'Two on-chain transactions for this single API call:',
    `   1. Swap:    ${swap.hash}`,
    `   2. Payment: ${paymentHash ?? '(receipt header missing)'}`,
    '',
    'Wallet balances (post-call):',
    `   XRP:  ${xrpAfter} drops (${(Number(xrpAfter) / 1_000_000).toFixed(6)} XRP)`,
    `   ${label}:  ${tokenAfter} ${label}`,
    '',
    `XRP debited (swap + fees):    ${Number(xrpBefore) - Number(xrpAfter)} drops`,
    `${label} delivered (total):    ${iouValue(Number(tokenAfter) - Number(tokenBefore) + Number(done.paid))}`,
    '',
    'The marketplace /info revealed nothing monetary: no currency, no issuer,',
    'no price. The client learned all three from the 402 alone, opened the',
    'trustline only then, queried the public testnet XRP/RLUSD AMM for a rate,',
    'sized the swap against its free faucet XRP, and paid -- all without any',
    'out-of-band negotiation, pre-shared price table, and without any wallet',
    'ever being funded with RLUSD.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
