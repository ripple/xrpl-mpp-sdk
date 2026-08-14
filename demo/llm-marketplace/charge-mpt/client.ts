/**
 * LLM Marketplace -- Charge mode (MPT) -- Client
 *
 * Fires ONE /complete request to the marketplace, billed in a
 * **Multi-Purpose Token (MPT)** called `CRED` (compute credits)
 * instead of native XRP or an IOU. The client holds **no client-side
 * price table**: the per-call cost (amount + MPT pair) is announced
 * inside the 402 challenge and surfaced via mppx's `onProgress` hook
 * the moment the challenge lands. The only number the client picks
 * is `maxTokens`, the worst-case output budget it's willing to
 * authorise.
 *
 * The /info endpoint still exposes the *MPT identifier* (issuance id
 * + human label) because the holder must MPTokenAuthorize before any
 * MPT Payment can clear. That's "which token", not "what it costs".
 *
 * MPT vs IOU on the wire:
 *   - IOU currency : { currency: "USD", issuer: "rIssuer..." }
 *   - MPT currency : { mpt_issuance_id: "<64-char hex>" }
 *
 * Bootstrap (one-time, before the paid call):
 *   1. Fund a fresh wallet via the XRPL testnet faucet (XRP for the
 *      MPToken owner-object reserve and tx fees -- not what we're
 *      paying *with*).
 *   2. GET /info -- discover issuer + recipient + MPT identifier + model.
 *      Does NOT advertise per-token pricing.
 *   3. acceptToken(mpt) -- holder-side MPTokenAuthorize. Status will
 *      be `pending_authorization` because the issuance requires the
 *      issuer's countersignature (the marketplace's allowlist).
 *   4. POST /faucet-mpt -- the marketplace authorises us as a holder
 *      (issuer-side MPTokenAuthorize) and issues 10 000 CRED in one
 *      shot. Demo bootstrap; in production this would be a paid
 *      top-up after KYC / subscription.
 *
 * Then POST /complete with { prompt, maxTokens }; mppx intercepts the
 * 402, the `onProgress` hook logs the price the marketplace just
 * announced, and the MPT Payment is signed for that exact amount.
 *
 * Run: npx tsx demo/llm-marketplace/charge-mpt/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge-mpt/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../../../sdk/src/client/fetch.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3009
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
  actual_cost: number
  paid: number
  overpayment: number
  token_label: string
}

type Info = {
  issuer: string
  recipient: string
  network: string
  token: { label: string; mpt_issuance_id: string }
  model: string
  faucetAllowanceCredits: number
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

async function fetchFaucetMpt(
  holder: string,
): Promise<{ authorizeTxHash: string; issueTxHash: string }> {
  const res = await rawFetch(`${BASE}/faucet-mpt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder }),
  })
  if (!res.ok) throw new Error(`/faucet-mpt failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { authorizeTxHash: string; issueTxHash: string }
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, MPT credits billing)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer', wallet.address)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('Marketplace issuer', info.issuer)
  log.wallet('Marketplace recipient', info.recipient)
  log.info(`Token to opt in to: ${info.token.label} (MPT)`)
  log.key('MPTokenIssuanceID', info.token.mpt_issuance_id)
  log.info(`Model: ${info.model}`)
  log.info('Per-call price: not advertised here -- will arrive in the 402 on /complete')
  log.separator()

  // Holder-side MPTokenAuthorize. Creates an MPToken object on the payer
  // account (1 owner reserve). Status will be `pending_authorization`
  // because the issuance has `requireAuthorization: true` -- the
  // marketplace must counter-sign before we can actually hold a balance.
  const mpt = { mpt_issuance_id: info.token.mpt_issuance_id }
  log.loading(`Opting in to ${info.token.label} (holder-side MPTokenAuthorize)...`)
  const accept = await wallet.acceptToken(mpt, { network: NETWORK })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.info(`Holder status: ${accept.status}`)
  log.separator()

  // Ask the marketplace to authorise us (issuer-side MPTokenAuthorize)
  // and credit our demo allowance in one HTTP call.
  log.loading(
    `Requesting demo allowance from /faucet-mpt ` +
      `(${info.faucetAllowanceCredits} ${info.token.label})...`,
  )
  const faucet = await fetchFaucetMpt(wallet.address)
  log.tx(faucet.authorizeTxHash, log.explorerLink(faucet.authorizeTxHash))
  log.tx(faucet.issueTxHash, log.explorerLink(faucet.issueTxHash))
  log.success(`Payer credited with ${info.faucetAllowanceCredits} ${info.token.label}`)
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
              `402 received -- price: ${formatAmount(evt.amount, evt.currency, info.token.label)}`,
            )
            log.info(`Payable to: ${evt.recipient}`)
          } else if (evt.type === 'signing') {
            log.info('Signing the MPT Payment tx with the quoted amount...')
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

  const overpayPct = done.paid > 0 ? ((done.overpayment / done.paid) * 100).toFixed(1) : '0.0'
  const remaining = info.faucetAllowanceCredits - done.paid

  // Render everything in the unit the client learned from the 402,
  // tagged with the friendly token label the server hinted at boot.
  const wire = captured.quote?.currency ?? '<unknown>'
  const label = done.token_label

  log.box([
    'Settlement -- charge in MPT credits',
    '',
    `Anthropic usage:   ${done.input_tokens} input + ${done.output_tokens} output tokens`,
    `Actual cost:       ${formatAmount(done.actual_cost, wire, label)}`,
    `Paid (quote):      ${formatAmount(done.paid, wire, label)} (worst case, learned from the 402)`,
    `Overpayment:       ${formatAmount(done.overpayment, wire, label)} (${overpayPct}%)`,
    `Remaining balance: ${formatAmount(remaining, wire, label)} (of ${info.faucetAllowanceCredits} ${label} faucet)`,
    '',
    'Charge mode: 1 on-chain MPT Payment tx settled the whole call.',
    'No trustline reserve on the holder -- just one MPToken owner object.',
    'Price discovery: the 402 challenge -- no client-side price table.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
