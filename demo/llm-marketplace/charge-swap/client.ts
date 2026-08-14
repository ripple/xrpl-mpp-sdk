/**
 * LLM Marketplace -- Charge mode (single IOU, agent swaps) -- Client
 *
 * The marketplace's /complete endpoint replies with a 402 carrying ONE
 * `WWW-Authenticate: Payment` challenge, denominated in `CRD` -- a
 * marketplace-local IOU. The agent does NOT hold CRD. It only holds a
 * USD-pegged IOU it picked up from /faucet-usd.
 *
 * What the agent has to figure out, on its own, before it can pay:
 *
 *   1. "I have 10 USD and 0 CRD. The 402 wants ~0.06 CRD."
 *   2. "There is a USD/CRD AMM pool on the testnet DEX."
 *   3. "I should swap a bit more USD than the quote -- enough to cover
 *       the 0.5% AMM trading fee + a small slippage buffer."
 *   4. "Then I retry /complete with a CRD credential."
 *
 * The swap itself is a single XRPL transaction: a cross-currency
 * Payment from the agent to itself, with `Amount` in CRD and `SendMax`
 * in USD. rippled's path-finder picks up the AMM pool automatically;
 * no Paths field is needed. The credential for the second /complete
 * call is then built with the SDK's `charge` method, which signs a
 * normal CRD Payment to the marketplace -- the swap is over by then.
 *
 * No "/quote", no client-side price table, no pre-negotiated currency:
 * the only thing the server told the client was "I take CRD". The
 * agent had to source it.
 *
 * Run: npx tsx demo/llm-marketplace/charge-swap/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge-swap/server.ts`)
 */
import { Challenge, Receipt } from 'mppx'
import { Client, type Payment } from 'xrpl'
import { charge } from '../../../sdk/src/client/Charge.js'
import { XRPL_RPC_URLS } from '../../../sdk/src/constants.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { MODEL } from '../shared/anthropic.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3011
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const PROMPT = 'Explain in one short paragraph why agents need on-chain DEX access.'
const MAX_TOKENS = 120

/**
 * Slippage cushion the agent adds on top of the AMM-quoted USD cost.
 * 5% absorbs the trading fee (0.5%) + price drift between amm_info and
 * tx submission + IOU value rounding. The Payment carries `SendMax` so
 * we never overspend; this is just a permission band.
 */
const SLIPPAGE_PCT = 5

type Info = {
  recipient: string
  issuer: string
  network: string
  model: string
  chargeCurrency: { currency: string; issuer: string }
  chargeCurrencyLabel: string
  bootstrapCurrency: { currency: string; issuer: string }
  bootstrapCurrencyLabel: string
  faucetAllowanceUsd: string
  payerTrustlineLimit: string
}

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

async function fetchFaucetUsd(holder: string): Promise<{ txHash: string }> {
  const res = await fetch(`${BASE}/faucet-usd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder }),
  })
  if (!res.ok) throw new Error(`/faucet-usd failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { txHash: string }
}

/** Render a JS number as an XRPL IOU value string (15 sig digits max). */
function iouValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

type AmmQuote = {
  /** USD reserve in the AMM (string with full precision). */
  usdReserve: string
  /** CRD reserve in the AMM. */
  credReserve: string
  /** Trading fee, units of 1/100 000 (e.g. 500 == 0.5%). */
  tradingFeeUnits: number
  /** USD needed to receive `requestedCred` from the pool, *before* slippage. */
  usdQuotedForRequest: string
}

/**
 * Read the AMM pool depth and compute the USD-in required to receive
 * exactly `requestedCred` CRD-out, using the constant-product invariant
 *
 *   (X + dx) * (Y - dy) = X * Y
 *
 * with X = USD reserve, Y = CRD reserve, dy = requestedCred. The
 * trading fee is taken on the *input* side, so:
 *
 *   dx_pre_fee = X * dy / (Y - dy)
 *   dx_after_fee = dx_pre_fee / (1 - fee)
 *
 * (matches rippled's AMM math; see XLS-30d).
 */
async function quoteSwap(xrpl: Client, info: Info, requestedCred: string): Promise<AmmQuote> {
  // The pool address is never advertised: we discover the pool purely
  // from the token PAIR we want to trade (USD we hold, CRD we owe).
  const ammInfo = (await xrpl.request({
    command: 'amm_info',
    asset: info.bootstrapCurrency,
    asset2: info.chargeCurrency,
  } as any)) as any

  const a = ammInfo.result?.amm
  if (!a) throw new Error('amm_info returned no AMM (pool missing?)')
  // The response may return assets in either field order. Pick by currency.
  const sideA = a.amount
  const sideB = a.amount2
  const sideAcurrency = typeof sideA === 'object' ? sideA.currency : null
  const usdSide = sideAcurrency === info.bootstrapCurrency.currency ? sideA : sideB
  const credSide = sideAcurrency === info.bootstrapCurrency.currency ? sideB : sideA
  const X = Number(usdSide.value)
  const Y = Number(credSide.value)
  const dy = Number(requestedCred)
  if (dy >= Y) {
    throw new Error(
      `Pool too shallow: want ${dy} ${info.chargeCurrencyLabel} but only ${Y} available.`,
    )
  }
  const dxPreFee = (X * dy) / (Y - dy)
  // Trading fee comes from the on-chain pool itself, not from /info.
  const tradingFeeUnits = Number(a.trading_fee)
  const feeFraction = tradingFeeUnits / 100_000
  const dxAfterFee = dxPreFee / (1 - feeFraction)
  return {
    usdReserve: usdSide.value,
    credReserve: credSide.value,
    tradingFeeUnits,
    usdQuotedForRequest: iouValue(dxAfterFee),
  }
}

/** Read the wallet's IOU balance toward a given issuer; returns '0' if none. */
async function readIouBalance(
  wallet: Wallet,
  currency: { currency: string; issuer: string },
): Promise<string> {
  const h = await wallet.holdsToken(currency, { network: NETWORK })
  if (h && 'balance' in h && h.balance) return h.balance
  return '0'
}

/**
 * Submit the actual swap. A cross-currency Payment from the agent to
 * itself: `Amount` is the exact CRD we want out, `SendMax` is the
 * agent's spend cap in USD (quote + slippage). rippled discovers the
 * USD/CRD AMM via path-finding and executes the swap atomically.
 *
 * Returns the tx hash and the *delivered* CRD value parsed from the
 * tx meta (in practice == requestedCred since this is a fixed-out
 * payment, but we read it back for the log).
 */
async function swapUsdToCred(
  xrpl: Client,
  wallet: Wallet,
  info: Info,
  requestedCred: string,
  usdMax: string,
): Promise<{ hash: string; deliveredCred: string }> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: wallet.address,
    Amount: {
      currency: info.chargeCurrency.currency,
      issuer: info.chargeCurrency.issuer,
      value: requestedCred,
    },
    SendMax: {
      currency: info.bootstrapCurrency.currency,
      issuer: info.bootstrapCurrency.issuer,
      value: usdMax,
    },
  }

  const result = await xrpl.submitAndWait(tx, { wallet: wallet._xrplWallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `Swap failed: ${meta?.TransactionResult ?? 'unknown'} (hash ${result.result.hash})`,
    )
  }
  // delivered_amount lives under meta.delivered_amount (or meta.DeliveredAmount).
  // For an IOU it is an object { currency, issuer, value }.
  const delivered = meta.delivered_amount ?? meta.DeliveredAmount
  const deliveredCred =
    delivered && typeof delivered === 'object' && 'value' in delivered
      ? String(delivered.value)
      : requestedCred
  return { hash: result.result.hash, deliveredCred }
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, IOU-only, agent swaps USD -> CRD)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer (agent)', wallet.address)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('Marketplace recipient', info.recipient)
  log.wallet('Marketplace issuer', info.issuer)
  log.info(`Model: ${info.model}`)
  log.info(
    `Charging in: ${info.chargeCurrencyLabel} (issuer ${info.chargeCurrency.issuer.slice(0, 6)}…${info.chargeCurrency.issuer.slice(-4)})`,
  )
  log.info(`Bootstrap (faucet): ${info.bootstrapCurrencyLabel} (same issuer)`)
  log.info(
    `DEX pool address: not advertised -- discovered from the ` +
      `${info.bootstrapCurrencyLabel}/${info.chargeCurrencyLabel} pair`,
  )
  log.info(
    'Per-call price: not advertised here -- arrives in the 402 on /complete, ' +
      `in ${info.chargeCurrencyLabel} only.`,
  )
  log.separator()

  // Open BOTH trustlines up front: USD (we'll hold the faucet allowance)
  // and CRD (we'll receive it from the swap). Either trustline missing
  // would block its side of the flow.
  log.loading(
    `Opening trustlines: payer accepts up to ${info.payerTrustlineLimit} each of ` +
      `${info.bootstrapCurrencyLabel} and ${info.chargeCurrencyLabel}...`,
  )
  const [acceptUsd, acceptCred] = await Promise.all([
    wallet.acceptToken(info.bootstrapCurrency, {
      network: NETWORK,
      limit: info.payerTrustlineLimit,
    }),
    wallet.acceptToken(info.chargeCurrency, {
      network: NETWORK,
      limit: info.payerTrustlineLimit,
    }),
  ])
  if ('hash' in acceptUsd && acceptUsd.hash) {
    log.tx(acceptUsd.hash, log.explorerLink(acceptUsd.hash))
  }
  if ('hash' in acceptCred && acceptCred.hash) {
    log.tx(acceptCred.hash, log.explorerLink(acceptCred.hash))
  }
  log.success(
    `Trustlines: ${info.bootstrapCurrencyLabel}=${acceptUsd.status}, ` +
      `${info.chargeCurrencyLabel}=${acceptCred.status}`,
  )

  log.loading(
    `Requesting demo USD allowance from /faucet-usd (${info.faucetAllowanceUsd} ${info.bootstrapCurrencyLabel})...`,
  )
  const faucet = await fetchFaucetUsd(wallet.address)
  log.tx(faucet.txHash, log.explorerLink(faucet.txHash))
  log.success(
    `Payer credited with ${info.faucetAllowanceUsd} ${info.bootstrapCurrencyLabel} ` +
      `(but the marketplace only takes ${info.chargeCurrencyLabel} -- swap needed)`,
  )
  log.separator()

  // Snapshot pre-call balances. The agent will reason against these.
  const [xrpBefore, usdBefore, credBefore] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    readIouBalance(wallet, info.bootstrapCurrency),
    readIouBalance(wallet, info.chargeCurrency),
  ])
  log.box([
    'Wallet balances (pre-call)',
    '',
    `XRP:                ${xrpBefore} drops (${(Number(xrpBefore) / 1_000_000).toFixed(6)} XRP)`,
    `${info.bootstrapCurrencyLabel}:                ${usdBefore} ${info.bootstrapCurrencyLabel}`,
    `${info.chargeCurrencyLabel}:                ${credBefore} ${info.chargeCurrencyLabel}  ← 0 (cannot pay yet)`,
  ])
  log.separator()

  // Configure the xrpl/charge SDK method. We use it AFTER the swap to
  // build the credential for the actual marketplace payment; the swap
  // itself is a plain xrpl.js Payment because it isn't an MPP step.
  const chargeMethod = charge({
    wallet,
    mode: 'pull',
    network: NETWORK,
    onProgress: (evt) => {
      if (evt.type === 'preflight') log.info('Running preflight (balance/path checks)...')
      else if (evt.type === 'pathfinding') log.info('ripple_path_find (IOU only)...')
      else if (evt.type === 'signing')
        log.info(`Signing the ${info.chargeCurrencyLabel} Payment tx...`)
      else if (evt.type === 'confirmed') log.info(`Tx submitted: ${evt.hash}`)
    },
  })

  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading(`POST ${BASE}/complete -- expecting a 402 quoted in ${info.chargeCurrencyLabel}...`)
  log.separator()

  const requestBody = JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS })

  // --- Round 1: trigger the 402 with the CRD quote. ---
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
  const requestedCred = offer.request.amount

  log.challenge(
    `402 received -- 1 payment option (${info.chargeCurrencyLabel} only): ` +
      `${formatAmount(requestedCred, offer.request.currency, info.chargeCurrencyLabel)}`,
  )
  log.info(
    `Current ${info.chargeCurrencyLabel} balance: ${credBefore}  →  short ${requestedCred}. ` +
      'A swap is required before we can honor this challenge.',
  )
  log.separator()

  // --- Quote the swap against the live AMM. ---
  log.loading(
    `Querying AMM pool ${info.bootstrapCurrencyLabel}/${info.chargeCurrencyLabel} (amm_info)...`,
  )
  const xrpl = new Client(XRPL_RPC_URLS[NETWORK], { timeout: 60_000 })
  await xrpl.connect()
  let swap: { hash: string; deliveredCred: string }
  let quote: AmmQuote
  try {
    quote = await quoteSwap(xrpl, info, requestedCred)
    const usdWithSlippage = iouValue(Number(quote.usdQuotedForRequest) * (1 + SLIPPAGE_PCT / 100))

    log.info(
      `AMM depth: ${quote.usdReserve} ${info.bootstrapCurrencyLabel} : ` +
        `${quote.credReserve} ${info.chargeCurrencyLabel}` +
        `  (fee ${quote.tradingFeeUnits / 1000}%)`,
    )
    log.info(
      `AMM quote for ${requestedCred} ${info.chargeCurrencyLabel}: ` +
        `${quote.usdQuotedForRequest} ${info.bootstrapCurrencyLabel} ` +
        `(constant-product + fee).`,
    )
    log.info(
      `SendMax with ${SLIPPAGE_PCT}% slippage band: ${usdWithSlippage} ${info.bootstrapCurrencyLabel}`,
    )
    log.separator()

    log.loading(
      `Swapping ≤${usdWithSlippage} ${info.bootstrapCurrencyLabel} for ` +
        `${requestedCred} ${info.chargeCurrencyLabel} ` +
        `(cross-currency Payment self -> self via AMM)...`,
    )
    swap = await swapUsdToCred(xrpl, wallet, info, requestedCred, usdWithSlippage)
    log.tx(swap.hash, log.explorerLink(swap.hash))
    log.success(`Swap settled -- delivered ${swap.deliveredCred} ${info.chargeCurrencyLabel}`)
  } finally {
    await xrpl.disconnect()
  }

  const [usdAfterSwap, credAfterSwap] = await Promise.all([
    readIouBalance(wallet, info.bootstrapCurrency),
    readIouBalance(wallet, info.chargeCurrency),
  ])
  const usdSpentOnSwap = iouValue(Number(usdBefore) - Number(usdAfterSwap))
  log.box([
    `Post-swap balances`,
    '',
    `${info.bootstrapCurrencyLabel}:  ${usdAfterSwap} ${info.bootstrapCurrencyLabel}  (debited ${usdSpentOnSwap})`,
    `${info.chargeCurrencyLabel}:  ${credAfterSwap} ${info.chargeCurrencyLabel}  (received ${swap.deliveredCred})`,
  ])
  log.separator()

  // --- Round 2: build the credential and retry /complete. ---
  log.loading(
    `Building credential for the ${info.chargeCurrencyLabel} challenge ` +
      `(${requestedCred} ${info.chargeCurrencyLabel} -> recipient)...`,
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

  log.success(`Payment settled on-chain (paid in ${info.chargeCurrencyLabel})`)
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

  const [xrpAfter, usdAfter, credAfter] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    readIouBalance(wallet, info.bootstrapCurrency),
    readIouBalance(wallet, info.chargeCurrency),
  ])

  const overpayPct =
    Number(done.paid) > 0
      ? ((Number(done.overpayment) / Number(done.paid)) * 100).toFixed(1)
      : '0.0'

  log.box([
    'Settlement -- charge (paid in CRD, agent sourced CRD via DEX swap)',
    '',
    `Server quote:        ${formatAmount(done.paid, offer.request.currency, info.chargeCurrencyLabel)} (from the 402)`,
    `Actual cost:         ${formatAmount(done.actual_cost, offer.request.currency, info.chargeCurrencyLabel)} (Anthropic usage report)`,
    `Overpayment:         ${formatAmount(done.overpayment, offer.request.currency, info.chargeCurrencyLabel)} (${overpayPct}%)`,
    '',
    `Anthropic usage:     ${done.input_tokens} input + ${done.output_tokens} output tokens (${MODEL})`,
    '',
    'Two on-chain transactions for this single API call:',
    `   1. Swap:    ${swap.hash}`,
    `   2. Payment: ${paymentHash ?? '(receipt header missing)'}`,
    '',
    'Wallet balances (post-call):',
    `   XRP:  ${xrpAfter} drops (${(Number(xrpAfter) / 1_000_000).toFixed(6)} XRP)`,
    `   ${info.bootstrapCurrencyLabel}:  ${usdAfter} ${info.bootstrapCurrencyLabel}`,
    `   ${info.chargeCurrencyLabel}:  ${credAfter} ${info.chargeCurrencyLabel}`,
    '',
    `Source debited (total ${info.bootstrapCurrencyLabel}):  ${iouValue(Number(usdBefore) - Number(usdAfter))}`,
    `Target delivered (total ${info.chargeCurrencyLabel}):  ${iouValue(Number(credAfter) - Number(credBefore) + Number(done.paid))}`,
    '',
    'The marketplace only ever advertised CRD. The agent discovered',
    'the requirement, queried the testnet AMM for a USD/CRD rate, sized',
    'the swap (quote + slippage band), submitted it, then paid -- all',
    'without any out-of-band negotiation or pre-shared price table.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
