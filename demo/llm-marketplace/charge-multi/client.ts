/**
 * LLM Marketplace -- Charge mode (multi-currency, MPP-native) -- Client
 *
 * The marketplace's /complete endpoint replies with a 402 containing
 * **two** `WWW-Authenticate: Payment ...` challenges -- one for XRP, one
 * for USD. We parse both, see the actual per-call price for each, then
 * **let Claude itself decide** which currency to pay in (it's an LLM
 * marketplace, after all -- so the LLM also picks how to pay for itself).
 *
 * Notice what is NOT happening:
 *   - we do NOT send a `payWith` field in the body
 *   - we do NOT call any "/quote" endpoint
 *   - we do NOT consult a client-side price table
 *   - we do NOT hard-code the policy
 * The only place prices appear is inside the 402 the marketplace just
 * sent us. The decision is then taken by Claude itself, given the
 * 402 quotes and the agent's current balances.
 *
 * Wire shape per call:
 *   1.  POST /complete with `{ prompt, maxTokens }` (no Authorization)
 *   2.  402 -> parse `Challenge.fromResponseList(response)`
 *          -> two challenges: { amount, currency, recipient, ... } each
 *   3.  Ask Claude (via Anthropic API) which one to honor, given the
 *       two quotes and our current XRP + USD balances. The LLM returns
 *       strict JSON `{"payWith":"XRP"|"USD","reason":"..."}`.
 *   4.  Use the xrpl charge SDK method to build the credential for the
 *       chosen challenge (signs the right XRPL Payment; pull mode means
 *       we ship the signed blob to the server, which submits it)
 *   5.  POST /complete again with `Authorization: <credential>`
 *   6.  200 + SSE stream of Anthropic tokens, then settlement summary
 *
 * Override the LLM decision from the shell to demo each branch
 * deterministically (or pin behaviour in CI):
 *
 *   PAY_WITH=XRP  npx tsx demo/llm-marketplace/charge-multi/client.ts
 *   PAY_WITH=USD  npx tsx demo/llm-marketplace/charge-multi/client.ts
 *   PAY_WITH=auto npx tsx demo/llm-marketplace/charge-multi/client.ts   # default = ask Claude
 *
 * Run: npx tsx demo/llm-marketplace/charge-multi/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge-multi/server.ts`)
 */
import { Challenge, Receipt } from 'mppx'
import { charge } from '../../../sdk/src/client/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { createAnthropic, MODEL } from '../shared/anthropic.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3010
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const PROMPT = 'Explain what the Machine Payments Protocol does in one short paragraph.'
const MAX_TOKENS = 120

type PayPreference = 'auto' | 'XRP' | 'USD'

const PAY_PREFERENCE: PayPreference = ((): PayPreference => {
  const raw = (process.env.PAY_WITH ?? 'auto').toUpperCase()
  if (raw === 'XRP' || raw === 'USD' || raw === 'AUTO') {
    return raw === 'AUTO' ? 'auto' : (raw as PayPreference)
  }
  throw new Error(`Invalid PAY_WITH="${process.env.PAY_WITH}". Use XRP, USD, or auto.`)
})()

type Info = {
  recipient: string
  issuer: string
  network: string
  model: string
  iou: {
    currency: { currency: string; issuer: string }
    label: string
    faucetAllowanceUsd: string
    payerTrustlineLimitUsd: string
  }
}

/** Shape of the request inside a server-issued xrpl/charge challenge. */
type ChargeRequest = {
  amount: string
  currency: string
  recipient: string
}

type ChargeChallenge = Challenge.Challenge<ChargeRequest, 'charge', 'xrpl'>

type DoneEvent = {
  input_tokens: number
  output_tokens: number
  pay_with: 'XRP' | 'USD'
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

/** Identify a challenge as the XRP or the USD offer for human-friendly logs. */
function challengeKind(c: ChargeChallenge): 'XRP' | 'USD' {
  return c.request.currency === 'XRP' ? 'XRP' : 'USD'
}

/** Result of a single decision -- regardless of who took it. */
type Decision = {
  chosen: ChargeChallenge
  payWith: 'XRP' | 'USD'
  reason: string
  source: 'env-override' | 'llm' | 'local-fallback'
  /** Raw LLM completion -- present only when `source === 'llm'`. */
  llmRaw?: string
}

/**
 * Honour the `PAY_WITH` env override deterministically. Throws if the
 * override is set but the chosen option is missing or not affordable --
 * we don't want to silently fall back when the operator pinned a
 * specific currency for a demo/CI run.
 */
function decideViaOverride(input: {
  preference: 'XRP' | 'USD'
  offers: ChargeChallenge[]
  xrpBalanceDrops: string
  iouBalance: string
}): Decision {
  const { preference, offers, xrpBalanceDrops, iouBalance } = input
  const offer = offers.find((c) => challengeKind(c) === preference)
  if (!offer) {
    throw new Error(
      `PAY_WITH=${preference} but marketplace did not offer a ${preference} challenge.`,
    )
  }
  const balance = preference === 'XRP' ? xrpBalanceDrops : iouBalance
  if (Number(balance) < Number(offer.request.amount)) {
    throw new Error(
      `PAY_WITH=${preference} but balance ${balance} < quote ${offer.request.amount}.`,
    )
  }
  return {
    chosen: offer,
    payWith: preference,
    reason: `PAY_WITH=${preference} (env override) -- quote ${offer.request.amount} fits balance ${balance}`,
    source: 'env-override',
  }
}

/**
 * Ask Claude itself which currency to pay in. The model receives the
 * marketplace's two quotes from the 402 + the agent's current balances,
 * and must reply with strict JSON: `{"payWith":"XRP"|"USD","reason":"..."}`.
 *
 * No tooling / function-calling here on purpose -- a plain
 * messages.create + a strict JSON-only system prompt is enough for the
 * demo and keeps the wire shape transparent in the logs.
 */
async function decideViaLLM(input: {
  offers: ChargeChallenge[]
  xrpBalanceDrops: string
  iouBalance: string
  iouLabel: string
}): Promise<{ payWith: 'XRP' | 'USD'; reason: string; raw: string }> {
  const { offers, xrpBalanceDrops, iouBalance, iouLabel } = input

  const xrpOffer = offers.find((c) => challengeKind(c) === 'XRP')
  const usdOffer = offers.find((c) => challengeKind(c) === 'USD')
  if (!xrpOffer || !usdOffer) {
    throw new Error('LLM decision requires both an XRP and a USD offer in the 402.')
  }

  const xrpQuoteDrops = xrpOffer.request.amount
  const xrpQuoteXrp = (Number(xrpQuoteDrops) / 1_000_000).toFixed(6)
  const usdQuote = usdOffer.request.amount
  const xrpBalanceXrp = (Number(xrpBalanceDrops) / 1_000_000).toFixed(6)

  // Hard-pin the model output to one of the two valid choices via a
  // terse system + user prompt. We intentionally tell Claude WHY each
  // currency exists -- volatility (XRP) vs USD-pegged predictability
  // (the IOU) -- so its reasoning is informed by the same trade-offs
  // a human treasurer would think about.
  const system =
    'You are a treasury agent for an AI workload. ' +
    'You decide which currency to pay an LLM marketplace with, for a SINGLE inference call. ' +
    'Reply with strict JSON only -- no preamble, no Markdown fences, no extra text. ' +
    'Schema: {"payWith":"XRP"|"USD","reason":"<1-2 sentences explaining the trade-off you weighed>"}.'

  const user =
    'The marketplace just sent a 402 with two acceptable payment options for this call.\n' +
    '\n' +
    'My current balances:\n' +
    `  - XRP: ${xrpBalanceXrp} XRP (${xrpBalanceDrops} drops)\n` +
    `  - ${iouLabel} (USD-pegged IOU): ${iouBalance} ${iouLabel}\n` +
    '\n' +
    'Marketplace quotes for THIS call:\n' +
    `  - Option XRP: ${xrpQuoteDrops} drops (${xrpQuoteXrp} XRP)\n` +
    `  - Option ${iouLabel}: ${usdQuote} ${iouLabel}\n` +
    '\n' +
    'Trade-offs:\n' +
    '  - XRP is native and cheap to settle, but its USD price is volatile.\n' +
    `  - ${iouLabel} is pegged 1:1 to USD, so the budget is predictable across calls.\n` +
    '  - Either option must be fully covered by the matching balance.\n' +
    '\n' +
    'Which payment method should I pick? Reply with the JSON schema only.'

  const anthropic = createAnthropic()
  const completion = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    system,
    messages: [{ role: 'user', content: user }],
  })

  const rawText = completion.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')

  // Log the agent's answer the moment it lands, so the reasoning is
  // visible even if parsing fails below (and independent of main()'s
  // later summary logging).
  log.info(`Claude answered: ${rawText.trim()}`)

  // Extract the first {...} block tolerantly -- Haiku occasionally
  // wraps strict JSON in extra whitespace or, rarely, a fence.
  const start = rawText.indexOf('{')
  const end = rawText.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`LLM did not return a JSON object. Raw: ${rawText.slice(0, 200)}`)
  }
  const parsed = JSON.parse(rawText.slice(start, end + 1)) as {
    payWith?: unknown
    reason?: unknown
  }
  if (parsed.payWith !== 'XRP' && parsed.payWith !== 'USD') {
    throw new Error(`LLM picked an invalid payWith: ${String(parsed.payWith)}`)
  }
  return {
    payWith: parsed.payWith,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '(no reason provided)',
    raw: rawText.trim(),
  }
}

/**
 * Last-resort local heuristic when the LLM call fails or returns an
 * unparseable response. Same shape as the LLM branch so the rest of
 * the flow doesn't care which path produced the decision.
 *
 * Policy: prefer the USD IOU when the quote fits the current USD
 * balance (stable budget unit); else fall back to native XRP.
 */
function decideLocalFallback(input: {
  offers: ChargeChallenge[]
  xrpBalanceDrops: string
  iouBalance: string
}): Decision {
  const { offers, xrpBalanceDrops, iouBalance } = input
  const xrpOffer = offers.find((c) => challengeKind(c) === 'XRP')
  const usdOffer = offers.find((c) => challengeKind(c) === 'USD')

  const canPayXrp = !!xrpOffer && Number(xrpBalanceDrops) >= Number(xrpOffer.request.amount)
  const canPayUsd = !!usdOffer && Number(iouBalance) >= Number(usdOffer.request.amount)

  if (canPayUsd && usdOffer) {
    return {
      chosen: usdOffer,
      payWith: 'USD',
      reason: `local fallback: USD quote ${usdOffer.request.amount} fits balance ${iouBalance}`,
      source: 'local-fallback',
    }
  }
  if (canPayXrp && xrpOffer) {
    return {
      chosen: xrpOffer,
      payWith: 'XRP',
      reason: `local fallback: XRP quote ${xrpOffer.request.amount} drops fits balance ${xrpBalanceDrops}`,
      source: 'local-fallback',
    }
  }
  throw new Error('Neither payment option is affordable with current balances.')
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, multi-challenge 402)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer', wallet.address)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('Marketplace recipient', info.recipient)
  log.wallet('Marketplace issuer', info.issuer)
  log.info(`Model: ${info.model}`)
  log.info(
    `IOU on offer: ${info.iou.label} (issuer ${info.iou.currency.issuer.slice(0, 6)}…${info.iou.currency.issuer.slice(-4)})`,
  )
  log.info('Per-call price: not advertised here -- will arrive (twice) in the 402 on /complete')
  log.separator()

  // Open the trustline + grab the demo allowance. Both are sunk costs
  // of having USD as a viable option at all -- we want a fair comparison
  // in the decision policy.
  log.loading(
    `Opening trustline: payer accepts up to ${info.iou.payerTrustlineLimitUsd} ${info.iou.label}...`,
  )
  const accept = await wallet.acceptToken(info.iou.currency, {
    network: NETWORK,
    limit: info.iou.payerTrustlineLimitUsd,
  })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.success(`Trustline status: ${accept.status}`)

  log.loading(
    `Requesting demo allowance from /faucet-usd (${info.iou.faucetAllowanceUsd} ${info.iou.label})...`,
  )
  const faucetIou = await fetchFaucetUsd(wallet.address)
  log.tx(faucetIou.txHash, log.explorerLink(faucetIou.txHash))
  log.success(`Payer credited with ${info.iou.faucetAllowanceUsd} ${info.iou.label}`)
  log.separator()

  // Snapshot pre-call balances. The decision policy compares them
  // against the actual per-call quotes from the 402.
  const [xrpBalance, iouHolding] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    wallet.holdsToken(info.iou.currency, { network: NETWORK }),
  ])
  const iouBalance = iouHolding && 'balance' in iouHolding ? iouHolding.balance : '0'

  log.box([
    'Wallet balances (pre-call)',
    '',
    `XRP:  ${xrpBalance} drops (${(Number(xrpBalance) / 1_000_000).toFixed(6)} XRP)`,
    `${info.iou.label}:  ${iouBalance} ${info.iou.label}`,
  ])
  log.separator()

  // Configure the xrpl/charge SDK method directly -- we don't go through
  // Mppx.create() because the auto fetch wrapper would pick the FIRST
  // matching challenge for us, and we want to choose between two
  // xrpl/charge challenges ourselves.
  const chargeMethod = charge({
    wallet,
    mode: 'pull',
    network: NETWORK,
    onProgress: (evt) => {
      if (evt.type === 'preflight') log.info('Running preflight (balance/path checks)...')
      else if (evt.type === 'pathfinding') log.info('ripple_path_find (IOU only)...')
      else if (evt.type === 'signing') log.info('Signing the XRPL Payment tx...')
      else if (evt.type === 'confirmed') log.info(`Tx submitted: ${evt.hash}`)
    },
  })

  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading(`POST ${BASE}/complete -- expect a 402 with TWO challenges...`)
  log.separator()

  const requestBody = JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS })

  // --- Round 1: trigger the 402 with both offers. ---
  const probe = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  })

  if (probe.status !== 402) {
    log.error(`Expected 402, got ${probe.status}: ${await probe.text()}`)
    process.exit(1)
  }

  // Parse ALL challenges -- the marketplace sent two WWW-Authenticate
  // headers, one per currency. This is RFC 9110 §11.6.1 multi-challenge
  // and the Mppx-native way to express "I accept X or Y".
  const offers = Challenge.fromResponseList(probe) as ChargeChallenge[]
  if (offers.length === 0) {
    log.error('402 carried no Payment challenges -- nothing to honor.')
    process.exit(1)
  }

  log.challenge(`402 received -- ${offers.length} payment option(s):`)
  for (const o of offers) {
    const kind = challengeKind(o)
    const label = kind === 'USD' ? info.iou.label : undefined
    log.info(`   - ${kind}: ${formatAmount(o.request.amount, o.request.currency, label)}`)
  }
  log.separator()

  // --- The decision: env override > Claude > local fallback. ---
  //
  // The "ask Claude" branch is what makes this demo agentic: the same
  // LLM the marketplace runs is also the one picking how it gets paid.
  // Given the two quotes from the 402 + the on-chain balances, Claude
  // returns strict JSON `{"payWith":"XRP"|"USD","reason":"..."}`.
  let decision: Decision
  if (PAY_PREFERENCE !== 'auto') {
    decision = decideViaOverride({
      preference: PAY_PREFERENCE,
      offers,
      xrpBalanceDrops: xrpBalance,
      iouBalance,
    })
  } else {
    log.loading(`Asking Claude (${MODEL}) to pick a payment currency...`)
    try {
      const llm = await decideViaLLM({
        offers,
        xrpBalanceDrops: xrpBalance,
        iouBalance,
        iouLabel: info.iou.label,
      })
      const chosen = offers.find((c) => challengeKind(c) === llm.payWith)
      if (!chosen) throw new Error(`LLM picked ${llm.payWith} but no such offer in the 402.`)
      decision = {
        chosen,
        payWith: llm.payWith,
        reason: llm.reason,
        source: 'llm',
        llmRaw: llm.raw,
      }
    } catch (err: any) {
      log.error(`LLM decision unusable (${err.message}) -- falling back to local heuristic.`)
      decision = decideLocalFallback({
        offers,
        xrpBalanceDrops: xrpBalance,
        iouBalance,
      })
    }
  }

  if (decision.source === 'llm') {
    log.info(`Claude raw output: ${decision.llmRaw}`)
  }
  log.info(`Decision: pay in ${decision.payWith}  (source: ${decision.source})`)
  log.info(`Agent reasoning: ${decision.reason}`)
  log.separator()

  const chosenKind = decision.payWith

  // Build the credential for the chosen challenge. The SDK signs the
  // appropriate Payment tx (XRP drops or IOU value) under the hood.
  log.loading(`Signing the ${chosenKind} Payment tx for the chosen offer...`)
  const credentialHeader = await chargeMethod.createCredential({
    challenge: decision.chosen,
    context: { mode: 'pull' },
  })

  // --- Round 2: retry with the credential. compose() will dispatch to
  //     the handler matching `currency + amount + recipient`. ---
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

  log.success('Payment settled on-chain')
  try {
    const receipt = Receipt.fromResponse(response)
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

  // Read post-call balances to show the actual debit alongside the
  // marketplace's `paid`/`actual_cost` quote.
  const [xrpAfter, iouAfter] = await Promise.all([
    wallet.getXrpBalance({ network: NETWORK }),
    wallet.holdsToken(info.iou.currency, { network: NETWORK }),
  ])
  const iouAfterBalance = iouAfter && 'balance' in iouAfter ? iouAfter.balance : '0'

  const wire = decision.chosen.request.currency
  const friendlyLabel = done.pay_with === 'USD' ? info.iou.label : undefined
  const paidNum = Number(done.paid)
  const overpayNum = Number(done.overpayment)
  const overpayPct = paidNum > 0 ? ((overpayNum / paidNum) * 100).toFixed(1) : '0.0'

  log.box([
    `Settlement -- charge (paid in ${done.pay_with}, MPP multi-challenge)`,
    '',
    `Decision source:   ${decision.source}`,
    `Decision reason:   ${decision.reason}`,
    ...(decision.source === 'llm' && decision.llmRaw
      ? ['', `Claude raw output: ${decision.llmRaw}`]
      : []),
    '',
    `Anthropic usage:   ${done.input_tokens} input + ${done.output_tokens} output tokens`,
    `Actual cost:       ${formatAmount(done.actual_cost, wire, friendlyLabel)}`,
    `Paid (quote):      ${formatAmount(done.paid, wire, friendlyLabel)} ` +
      `(worst case, learned from the 402)`,
    `Overpayment:       ${formatAmount(done.overpayment, wire, friendlyLabel)} (${overpayPct}%)`,
    '',
    'Wallet balances (post-call):',
    `   XRP:  ${xrpAfter} drops (${(Number(xrpAfter) / 1_000_000).toFixed(6)} XRP)`,
    `   ${info.iou.label}:  ${iouAfterBalance} ${info.iou.label}`,
    '',
    'Charge mode (MPP-native multi-challenge): the 402 advertised BOTH',
    'XRP and USD options. Claude itself picked one based on balances +',
    'the EXACT per-call amounts the marketplace just sent. No "payWith"',
    'field, no /quote endpoint, no client-side price table, no hard-coded',
    'policy -- the agent decides.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
