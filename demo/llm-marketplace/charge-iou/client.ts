/**
 * LLM Marketplace -- Charge mode (IOU) -- Client
 *
 * Fires ONE /complete request to the marketplace, billed in an XRPL
 * issued currency (IOU) instead of native XRP. The client holds **no
 * client-side price table**: the per-call quote (amount + IOU pair) is
 * carried inside the 402 challenge and surfaced via mppx's `onProgress`
 * hook the moment it lands. The only number the client picks is
 * `maxTokens`, the worst-case output budget it's willing to authorise.
 *
 * The /info endpoint still exposes the *currency identifier* (issuer +
 * 3-char code) because the trustline needs that to open before any IOU
 * Payment can clear. That's "which token", not "what it costs".
 *
 * Bootstrap (one-time, before the paid call):
 *   1. Fund a fresh wallet via the XRPL testnet faucet (XRP for the
 *      trustline reserve and tx fees -- not what we're paying *with*).
 *   2. GET /info -- discover issuer + recipient + IOU identifier + model.
 *      Does NOT advertise per-token pricing.
 *   3. Open a trustline to the test USD issuer (acceptToken / TrustSet).
 *   4. POST /faucet-usd to receive the demo allowance (10 USD).
 *      Demo-only bootstrap; in production this would be a paid top-up
 *      (card payment, DEX swap, fiat on-ramp) targeting a real
 *      USD-pegged issuer such as Ripple's RLUSD.
 *
 * Then POST /complete with { prompt, maxTokens }; mppx intercepts the
 * 402, the `onProgress` hook logs the price the marketplace just
 * announced, and the IOU Payment is signed for that exact amount.
 *
 * Run: npx tsx demo/llm-marketplace/charge-iou/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge-iou/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../../../sdk/src/client/fetch.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3008
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const
const rawFetch = globalThis.fetch

// Edit the prompt + budget to taste. maxTokens is the worst-case the client
// is willing to pay for; the actual Anthropic generation will usually be less.
const PROMPT = 'Explain what the Machine Payments Protocol does in one short paragraph.'
const MAX_TOKENS = 120

type Quote = { recipient: string; amount: string; currency: string }

type DoneEvent = {
  input_tokens: number
  output_tokens: number
  actual_cost: string
  paid: string
  overpayment: string
  currency: string
}

type Info = {
  issuer: string
  recipient: string
  network: string
  currency: { currency: string; issuer: string }
  model: string
  faucetAllowanceUsd: string
  payerTrustlineLimitUsd: string
}

/** Parse text/event-stream chunks and yield { event, data } objects. */
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
  const res = await rawFetch(`${BASE}/info`)
  if (!res.ok) throw new Error(`/info failed: ${res.status}`)
  return (await res.json()) as Info
}

async function fetchFaucetUsd(holder: string): Promise<{ txHash: string }> {
  const res = await rawFetch(`${BASE}/faucet-usd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder }),
  })
  if (!res.ok) throw new Error(`/faucet-usd failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { txHash: string }
  return { txHash: json.txHash }
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, IOU billing)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer', wallet.address)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('Marketplace issuer', info.issuer)
  log.wallet('Marketplace recipient', info.recipient)
  log.info(
    `Currency to trust: ${info.currency.currency} ` +
      `(issuer ${info.currency.issuer.slice(0, 6)}...${info.currency.issuer.slice(-4)})`,
  )
  log.info(`Model: ${info.model}`)
  log.info('Per-call price: not advertised here -- will arrive in the 402 on /complete')
  log.separator()

  // TrustSet from the payer toward the issuer. Without this the payer
  // cannot hold or transfer USD, and the very first 402 fails at
  // preflight with PAYMENT_PATH_FAILED.
  log.loading(
    `Opening trustline: payer accepts up to ${info.payerTrustlineLimitUsd} ${info.currency.currency}...`,
  )
  const accept = await wallet.acceptToken(info.currency, {
    network: NETWORK,
    limit: info.payerTrustlineLimitUsd,
  })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.success(`Trustline status: ${accept.status}`)
  log.separator()

  log.loading(
    `Requesting demo allowance from /faucet-usd (${info.faucetAllowanceUsd} ${info.currency.currency})...`,
  )
  const faucetIou = await fetchFaucetUsd(wallet.address)
  log.tx(faucetIou.txHash, log.explorerLink(faucetIou.txHash))
  log.success(`Payer credited with ${info.faucetAllowanceUsd} ${info.currency.currency}`)
  log.separator()

  // Capture the 402 quote so we can log what the marketplace just asked
  // for, before mppx signs anything. This is the *first* moment the
  // client knows what this specific call costs.
  const captured: { quote: Quote | null } = { quote: null }

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
            captured.quote = {
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

  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading(`POST ${BASE}/complete -- price will arrive in the 402...`)
  log.separator()

  const response = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS }),
  })

  if (!response.ok) {
    log.error(`Request failed: ${response.status} ${await response.text()}`)
    process.exit(1)
  }

  if (!response.body) {
    log.error('No response body')
    process.exit(1)
  }

  log.success('Payment settled on-chain')
  try {
    const receipt = Receipt.fromResponse(response)
    log.tx(receipt.reference, log.explorerLink(receipt.reference))
  } catch {
    // No Payment-Receipt header -- still safe to continue, we just lose the link.
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

  const paid = Number(done.paid)
  const overpayment = Number(done.overpayment)
  const overpayPct = paid > 0 ? ((overpayment / paid) * 100).toFixed(1) : '0.0'
  const remaining = Number(info.faucetAllowanceUsd) - paid

  // Render everything in the unit the client learned from the 402. We
  // pass the IOU code as a friendly label so the box reads `0.06 USD`
  // rather than `0.06 USD` derived from a parsed JSON blob.
  const wire = captured.quote?.currency ?? '<unknown>'
  const label = done.currency

  log.box([
    'Settlement -- charge in IOU',
    '',
    `Anthropic usage:   ${done.input_tokens} input + ${done.output_tokens} output tokens`,
    `Actual cost:       ${formatAmount(done.actual_cost, wire, label)}`,
    `Paid (quote):      ${formatAmount(done.paid, wire, label)} (worst case, learned from the 402)`,
    `Overpayment:       ${formatAmount(done.overpayment, wire, label)} (${overpayPct}%)`,
    `Remaining balance: ${formatAmount(remaining, wire, label)} (of ${info.faucetAllowanceUsd} ${label} faucet)`,
    '',
    'Charge mode: 1 on-chain IOU Payment tx settled the whole call,',
    'denominated in an XRPL issued currency instead of native XRP.',
    'Price discovery: the 402 challenge -- no client-side price table.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
