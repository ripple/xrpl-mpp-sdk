/**
 * LLM Marketplace -- Charge mode (native XRP) -- Client
 *
 * The client knows NOTHING about the price or the currency before the 402:
 * it just POSTs /complete with `{ prompt, maxTokens }`. The marketplace
 * decides the quote and ships it inside the 402 challenge; mppx parses it
 * and we surface the (amount, currency) pair via the `onProgress` hook before
 * the payment is signed. Same pattern as a fiat checkout reading the
 * "amount due" off a Stripe-style invoice rather than computing it locally.
 *
 * Run: npx tsx demo/llm-marketplace/charge/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../../../sdk/src/client/fetch.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3003
const BASE = `http://localhost:${PORT}`

// The only two things the client decides up-front: what to ask, and the
// worst-case output budget it's willing to authorise. Everything monetary
// (unit price, currency, total quote) flows from the 402.
const PROMPT = 'Explain what the Machine Payments Protocol does in one short paragraph.'
const MAX_TOKENS = 120

type Quote = { recipient: string; amount: string; currency: string }

type DoneEvent = {
  input_tokens: number
  output_tokens: number
  actual_cost: number
  paid: number
  overpayment: number
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

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, native XRP)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: 'testnet' })
  log.wallet('Payer', wallet.address)
  log.separator()

  // Capture the 402 quote so we can show "what the marketplace asked for"
  // before printing the settlement summary. mppx invokes this synchronously
  // when the challenge is parsed, *before* the Payment is signed.
  const captured: { quote: Quote | null } = { quote: null }

  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  Mppx.create({
    methods: [
      charge({
        wallet,
        mode: 'pull',
        network: 'testnet',
        onProgress: (evt) => {
          if (evt.type === 'challenge') {
            captured.quote = {
              recipient: evt.recipient,
              amount: evt.amount,
              currency: evt.currency,
            }
            // First time the client knows the price for THIS call. Anything
            // before this log is pure protocol setup -- no money number was
            // available client-side.
            log.challenge(`402 received -- price: ${formatAmount(evt.amount, evt.currency)}`)
            log.info(`Payable to: ${evt.recipient}`)
          } else if (evt.type === 'signing') {
            log.info('Signing the Payment tx with the quoted amount...')
          } else if (evt.type === 'confirmed') {
            log.info(`Tx submitted: ${evt.hash}`)
          }
        },
      }),
    ],
  })

  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading(`POST ${BASE}/complete -- price + currency will arrive in the 402...`)
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

  // The unit comes from the 402 the client just received, not from a
  // client-side constant. `<unknown>` is a defensive fallback in case the
  // onProgress callback never fired (shouldn't happen on a 402 path).
  const unit = captured.quote?.currency ?? '<unknown>'
  const overpayPct = done.paid > 0 ? ((done.overpayment / done.paid) * 100).toFixed(1) : '0.0'

  log.box([
    'Settlement',
    '',
    `Anthropic usage:  ${done.input_tokens} input + ${done.output_tokens} output tokens`,
    `Actual cost:      ${formatAmount(done.actual_cost, unit)}`,
    `Paid (quote):     ${formatAmount(done.paid, unit)} (worst case, learned from the 402)`,
    `Overpayment:      ${formatAmount(done.overpayment, unit)} (${overpayPct}%)`,
    '',
    'Charge mode: 1 on-chain Payment tx settled the whole call.',
    'Price discovery: the 402 challenge -- no client-side price table.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
