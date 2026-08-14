/**
 * LLM Marketplace -- Charge mode (RLUSD) -- Fully autonomous agentic client
 *
 * The agent starts essentially blind. It is NOT told:
 *   - how much it owes
 *   - which token it owes (currency code or issuer)
 *   - who to pay
 *   - that any market/pool exists, which pair, any address, or any price
 *
 * The orchestrator script does almost nothing on-chain or on the wire on
 * the agent's behalf. It only: funds the wallet with XRP from the faucet
 * (so the agent has gas + something to trade), wires up three tools, and
 * runs the loop. EVERY meaningful action is a decision the agent makes:
 *
 *   - `probe_invoice`  -- the agent itself POSTs /complete to obtain the
 *                         402 invoice and reads the amount + token +
 *                         issuer + recipient out of it.
 *   - `xrpl_up`        -- the agent runs ANY `xrpl-up` CLI command it
 *                         constructs: read balances, open the trustline
 *                         for the token the invoice named, discover the
 *                         on-chain liquidity, and execute the swap.
 *   - `attempt_payment`-- once it holds enough of the token, settle the
 *                         invoice (the MPP credential dance, which has no
 *                         CLI equivalent).
 *
 * So the agent must reason its way through the entire flow: call the
 * marketplace, discover it owes a token it doesn't have and can't mint,
 * open a trustline, find where to buy that token with its XRP, size and
 * execute the trade, then pay. No wallet anywhere is ever funded with the
 * token -- the only units of it that exist here are the ones the agent
 * buys with free faucet XRP.
 *
 * Run: npx tsx demo/llm-marketplace/charge-swap-rlusd/client-agent.ts
 *      (after `npx tsx demo/llm-marketplace/charge-swap-rlusd/server.ts`)
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { Challenge, Receipt } from 'mppx'
import { charge } from '../../../sdk/src/client/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { createAnthropic, MODEL } from '../shared/anthropic.js'
import { decodeCurrencyCode, formatAmount } from '../shared/format.js'

const PORT = 3012
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const PROMPT = 'Explain in one short paragraph why agents need on-chain DEX access.'
const MAX_TOKENS = 120

/**
 * Trustline limit the agent sets for whatever token the 402 asks for, if
 * it doesn't pass one explicitly. A client-side risk choice -- the
 * marketplace never tells us this.
 */
const PAYER_TRUSTLINE_LIMIT = '1000'

/**
 * Default slippage cushion added on top of the AMM-quoted XRP cost when
 * the agent doesn't specify one. 5% absorbs the trading fee + price
 * drift between quote and submission + drop rounding. The swap carries
 * `SendMax`, so we never overspend -- this is only a permission band.
 */
const DEFAULT_SLIPPAGE_PCT = 5

/** Path to the `xrpl-up` binary installed locally as a devDependency. */
const XRPL_UP = resolve(process.cwd(), 'node_modules/.bin/xrpl-up')

/**
 * Hard cap on agent tool-use turns; safety net against runaway loops.
 * This agent has to discover the invoice, the token, the trustline need,
 * the CLI surface, and the liquidity by itself, so it needs some room.
 */
const MAX_AGENT_TURNS = 20

/**
 * Maximum stdout characters fed back to the LLM per command. `amm info`
 * / `account` JSON can be verbose; cap it so we don't blow the context.
 */
const MAX_TOOL_OUTPUT_CHARS = 4000

/**
 * `xrpl-up` subcommands that submit a signed transaction in this demo's
 * reach. For these the script injects the wallet seed (hidden from the
 * LLM). Everything else is read-only and must NOT receive a seed (those
 * subcommands reject the unknown `--seed` option). `trust` (trust set)
 * is here so the agent can open its own trustline; `payment`/`send` for
 * the swap.
 */
const SIGNING_SUBCOMMANDS = new Set(['payment', 'send', 'trust'])

type MarketplaceInfo = {
  recipient: string
  network: string
  model: string
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

// ---------- Shell wrapper around xrpl-up ----------

/**
 * Run an `xrpl-up` invocation and return its stdout/stderr/exit code.
 * Streams the command line to the demo log so the user can SEE the
 * agent's tool calls as they happen. Values following any flag listed in
 * `hideArgs` are redacted (used for `--seed`).
 */
function runXrplUp(
  args: string[],
  options: { hideArgs?: string[] } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const visibleArgs = args.map((a, i) => {
    const previous = args[i - 1]
    if (options.hideArgs?.includes(previous)) return '***'
    return a
  })
  log.cmd(`xrpl-up ${visibleArgs.join(' ')}`)
  return new Promise((resolveP, rejectP) => {
    const child = spawn(XRPL_UP, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8')
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8')
    })
    child.on('error', rejectP)
    child.on('close', (code) => {
      resolveP({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

// ---------- HTTP helpers ----------

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

async function fetchInfo(): Promise<MarketplaceInfo> {
  const res = await fetch(`${BASE}/info`)
  if (!res.ok) throw new Error(`/info failed: ${res.status}`)
  return (await res.json()) as MarketplaceInfo
}

// ---------- Generic xrpl-up tool ----------

/**
 * Execute an arbitrary `xrpl-up` command the agent constructed. The
 * script adds exactly two things the agent shouldn't have to think
 * about, neither of which leaks information about the liquidity:
 *
 *   1. pins the node to testnet (`--node testnet`) if the agent didn't,
 *   2. injects the wallet's signing seed for transaction subcommands
 *      (`payment`/`send`/`trust`) -- redacted in the log and never
 *      returned to the LLM.
 *
 * Returns the raw stdout/stderr/exit code so the agent reads exactly
 * what a human would see at the terminal.
 */
async function toolXrplUp(input: { wallet: Wallet; args: unknown }) {
  const { wallet } = input
  if (!Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string')) {
    return { error: 'args must be an array of strings, e.g. ["account","balance","r..."]' }
  }
  const args = input.args as string[]
  if (args.length === 0) {
    return { error: 'args must be a non-empty array of xrpl-up arguments' }
  }

  const finalArgs = [...args]
  if (!finalArgs.includes('--node') && !finalArgs.includes('-n')) {
    finalArgs.push('--node', NETWORK)
  }

  const hideArgs: string[] = []
  const submitsTx = SIGNING_SUBCOMMANDS.has(finalArgs[0]!)
  const hasSigner =
    finalArgs.includes('--seed') ||
    finalArgs.includes('--mnemonic') ||
    finalArgs.includes('--account')
  if (submitsTx && !hasSigner) {
    if (!wallet.seed) {
      return { error: 'Wallet has no exportable seed -- cannot sign transactions.' }
    }
    finalArgs.push('--seed', wallet.seed)
    hideArgs.push('--seed')
  }

  const res = await runXrplUp(finalArgs, { hideArgs })

  if (submitsTx && res.exitCode === 0) {
    try {
      const parsed = JSON.parse(res.stdout)
      const hash = parsed?.hash ?? parsed?.tx_hash ?? parsed?.result?.hash
      if (hash) log.tx(hash, log.explorerLink(hash))
    } catch {
      // Non-JSON output -- ignore.
    }
  }

  const clip = (s: string) =>
    s.length > MAX_TOOL_OUTPUT_CHARS
      ? `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_OUTPUT_CHARS} chars]`
      : s

  const stdout = clip(res.stdout.trim())
  const stderr = clip(res.stderr.trim())

  // Echo exactly what the CLI produced -- this is what the agent will
  // read on its next turn, so make it visible to the human too.
  if (res.exitCode === 0) {
    if (stdout) log.output(stdout)
    else log.output('(exit 0, no output)')
  } else {
    log.error(`exit ${res.exitCode}`)
    if (stdout) log.output(stdout)
    if (stderr) log.output(stderr)
  }

  return { exit_code: res.exitCode, stdout, stderr }
}

// ---------- probe_invoice tool (the agent makes the POST itself) ----------

/**
 * The agent calls the marketplace itself: POST /complete with no
 * credential, expect a 402, and read the invoice out of the challenge.
 * Captures the parsed Challenge object (via `setChallenge`) so a later
 * `attempt_payment` can build a credential against it. Returns the
 * monetary facts -- amount, token currency + issuer, recipient -- which
 * exist NOWHERE except this 402.
 */
async function toolProbeInvoice(input: {
  requestBody: string
  setChallenge: (c: ChargeChallenge) => void
}) {
  const { requestBody, setChallenge } = input
  log.request('POST', '/complete', 'no credential -- fetching the invoice')
  const res = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  })
  if (res.status !== 402) {
    return {
      ok: false,
      status: res.status,
      reason: `Expected a 402 invoice, got ${res.status}: ${(await res.text()).slice(0, 200)}`,
    }
  }
  log.response(402, 'Payment Required -- marketplace returned an invoice')
  let challenge: ChargeChallenge
  try {
    const offers = Challenge.fromResponseList(res) as ChargeChallenge[]
    if (offers.length !== 1) {
      return { ok: false, reason: `Expected exactly 1 challenge, got ${offers.length}` }
    }
    challenge = offers[0]!
  } catch (err: any) {
    return { ok: false, reason: `Could not parse the 402 challenge: ${err.message}` }
  }

  let parsed: { currency: string; issuer: string }
  try {
    parsed = JSON.parse(challenge.request.currency)
  } catch {
    return {
      ok: false,
      reason: `Challenge currency was not a JSON IOU descriptor: ${challenge.request.currency}`,
    }
  }

  setChallenge(challenge)
  const label = decodeCurrencyCode(parsed.currency)
  log.challenge(
    `Invoice: ${formatAmount(challenge.request.amount, challenge.request.currency, label)} ` +
      `-> ${challenge.request.recipient}`,
  )
  return {
    ok: true,
    status: 402,
    amount_due: challenge.request.amount,
    token_currency: parsed.currency,
    token_issuer: parsed.issuer,
    token_label: label,
    pay_to: challenge.request.recipient,
    note:
      `You owe ${challenge.request.amount} of token "${parsed.currency}" (issuer ${parsed.issuer}) ` +
      `to ${challenge.request.recipient}. You do not hold this token and cannot mint it. ` +
      'To pay you must actually hold it: you will need a trustline to its issuer, and you only ' +
      'have XRP, so you must acquire the token somehow. When you hold enough, call attempt_payment.',
  }
}

// ---------- open_trustline tool (uses our SDK, not the raw CLI) ----------

/**
 * Open the trustline the agent needs to hold the invoice's token, using
 * the SDK's `wallet.acceptToken` -- a single typed call instead of
 * hand-assembling an `xrpl-up trust set` invocation (currency must be
 * the 40-char hex, issuer, limit, ...). The token identity is read from
 * the captured 402 challenge, so the agent doesn't have to re-pass (and
 * possibly mistype) the hex currency code.
 */
async function toolOpenTrustline(input: {
  wallet: Wallet
  getChallenge: () => ChargeChallenge | null
  limit?: unknown
}) {
  const challenge = input.getChallenge()
  if (!challenge) {
    return {
      ok: false,
      reason: 'Fetch the invoice first (probe_invoice) so I know which token to trust.',
    }
  }
  let parsed: { currency: string; issuer: string }
  try {
    parsed = JSON.parse(challenge.request.currency)
  } catch {
    return {
      ok: false,
      reason: `Invoice currency was not a JSON IOU descriptor: ${challenge.request.currency}`,
    }
  }
  const label = decodeCurrencyCode(parsed.currency)
  const limit = typeof input.limit === 'string' && input.limit ? input.limit : PAYER_TRUSTLINE_LIMIT
  log.cmd(`SDK  wallet.acceptToken({ ${label}, ${parsed.issuer} }, limit ${limit})`)
  const res = await input.wallet.acceptToken(parsed, { network: NETWORK, limit })
  if ('hash' in res && res.hash) {
    log.tx(res.hash, log.explorerLink(res.hash))
  }
  log.output(`trustline status: ${res.status}`)
  return {
    ok: true,
    status: res.status,
    token: parsed.currency,
    issuer: parsed.issuer,
    label,
    limit,
    note: `Trustline toward ${label} is ${res.status}. You can now receive and hold ${label}.`,
  }
}

// ---------- acquire_token tool (pool discovery + swap via xrpl-up) ----------

/** Render XRP drops as an integer string for the wire (round up). */
function dropsValue(value: number): string {
  return String(Math.ceil(value))
}

/**
 * Parse the bare `amm` object printed by `xrpl-up amm info --json`. The
 * XRP side is a drops string; the token side is a `{ value, currency,
 * issuer }` object. We pick by type so we are robust to side ordering.
 */
function parseAmmJson(
  stdout: string,
  label: string,
): { xrpReserveDrops: number; tokenReserve: number; tradingFeeUnits: number } {
  let amm: any
  try {
    amm = JSON.parse(stdout)
  } catch {
    throw new Error(`amm info did not return JSON: ${stdout.slice(0, 200)}`)
  }
  const sideA = amm.amount
  const sideB = amm.amount2
  const xrpSide = typeof sideA === 'string' ? sideA : sideB
  const tokenSide = typeof sideA === 'string' ? sideB : sideA
  if (typeof xrpSide !== 'string' || !tokenSide || typeof tokenSide.value !== 'string') {
    throw new Error(`Unexpected amm info shape for XRP/${label} pool`)
  }
  return {
    xrpReserveDrops: Number(xrpSide),
    tokenReserve: Number(tokenSide.value),
    tradingFeeUnits: Number(amm.trading_fee),
  }
}

/**
 * Acquire the token the invoice demands by swapping XRP on the public
 * on-chain AMM, driving the `xrpl-up` CLI for both steps:
 *
 *   1. `xrpl-up amm info --asset XRP --asset2 <hex>/<issuer> --json`
 *      discovers the live pool purely from the token PAIR (the pool
 *      address is never advertised), and we read its depth + fee.
 *   2. `xrpl-up payment --to <self> --amount <token>/<hex>/<issuer>
 *      --send-max <drops>drops` submits a cross-currency Payment from the
 *      agent to itself; rippled path-finds the pool and executes the
 *      swap. `SendMax` caps the XRP spent so we never overspend.
 *
 * Sizing is automatic via the constant-product invariant with the fee on
 * the input side (matches rippled's AMM math, XLS-30d):
 *   dx_pre_fee   = X * dy / (Y - dy)
 *   dx_after_fee = dx_pre_fee / (1 - fee)
 * The script builds the commands and injects the seed (hidden from the
 * LLM), so the agent gets a reliable swap without guessing CLI syntax.
 */
async function toolAcquireToken(input: {
  wallet: Wallet
  getChallenge: () => ChargeChallenge | null
  slippagePct?: unknown
}) {
  const challenge = input.getChallenge()
  if (!challenge) {
    return {
      ok: false,
      reason: 'Fetch the invoice first (probe_invoice) so I know what to acquire.',
    }
  }
  let parsed: { currency: string; issuer: string }
  try {
    parsed = JSON.parse(challenge.request.currency)
  } catch {
    return {
      ok: false,
      reason: `Invoice currency was not a JSON IOU descriptor: ${challenge.request.currency}`,
    }
  }
  const label = decodeCurrencyCode(parsed.currency)
  const amountDue = challenge.request.amount
  // Buy a touch more than the invoice so fees/rounding never leave us short.
  const targetToken = Number(Number(amountDue) * 1.02).toPrecision(12)
  const slippagePct =
    typeof input.slippagePct === 'number' && input.slippagePct > 0
      ? input.slippagePct
      : DEFAULT_SLIPPAGE_PCT
  const asset2 = `${parsed.currency}/${parsed.issuer}`

  // --- 1. Discover the pool with `xrpl-up amm info`. ---
  const ammRes = await runXrplUp([
    'amm',
    'info',
    '--asset',
    'XRP',
    '--asset2',
    asset2,
    '--json',
    '--node',
    NETWORK,
  ])
  if (ammRes.exitCode !== 0) {
    log.error(`exit ${ammRes.exitCode}`)
    const detail = (ammRes.stderr || ammRes.stdout).trim()
    if (detail) log.output(detail)
    return { ok: false, reason: `amm info failed (no XRP/${label} pool?): ${detail.slice(0, 200)}` }
  }
  let pool: { xrpReserveDrops: number; tokenReserve: number; tradingFeeUnits: number }
  try {
    pool = parseAmmJson(ammRes.stdout.trim(), label)
  } catch (err: any) {
    return { ok: false, reason: err.message }
  }
  const { xrpReserveDrops: X, tokenReserve: Y, tradingFeeUnits } = pool
  const dy = Number(targetToken)
  if (dy >= Y) {
    return { ok: false, reason: `Pool too shallow: want ${dy} ${label} but only ${Y} available.` }
  }
  const dxPreFee = (X * dy) / (Y - dy)
  const dxAfterFee = dxPreFee / (1 - tradingFeeUnits / 100_000)
  const xrpDropsMax = dropsValue(dxAfterFee * (1 + slippagePct / 100))
  log.output(
    `pool depth ${(X / 1_000_000).toFixed(2)} XRP : ${Y} ${label} ` +
      `(fee ${tradingFeeUnits / 1000}%); SendMax ${xrpDropsMax} drops ` +
      `(${(Number(xrpDropsMax) / 1_000_000).toFixed(6)} XRP, +${slippagePct}%)`,
  )

  // --- 2. Execute the swap with `xrpl-up payment` (self -> self). ---
  if (!input.wallet.seed) {
    return { ok: false, reason: 'Wallet has no exportable seed -- cannot sign the swap.' }
  }
  const swapRes = await runXrplUp(
    [
      'payment',
      '--to',
      input.wallet.address,
      '--amount',
      `${targetToken}/${parsed.currency}/${parsed.issuer}`,
      '--send-max',
      `${xrpDropsMax}drops`,
      '--node',
      NETWORK,
      '--seed',
      input.wallet.seed,
    ],
    { hideArgs: ['--seed'] },
  )
  if (swapRes.exitCode !== 0 || !/tesSUCCESS/.test(swapRes.stdout)) {
    log.error(`exit ${swapRes.exitCode}`)
    const detail = (swapRes.stderr || swapRes.stdout).trim()
    if (detail) log.output(detail)
    return { ok: false, reason: `swap payment failed: ${detail.slice(0, 300)}` }
  }
  const hash = swapRes.stdout.match(/Transaction:\s*([0-9A-Fa-f]+)/)?.[1] ?? ''
  if (hash) log.tx(hash, log.explorerLink(hash))
  log.output(swapRes.stdout.trim())
  return {
    ok: true,
    swap_tx_hash: hash || null,
    delivered: targetToken,
    label,
    amount_due: amountDue,
    note:
      `Swapped XRP for ${targetToken} ${label} via the public AMM (xrpl-up payment). You now ` +
      `hold enough ${label} to cover the ${amountDue} due. Call attempt_payment to settle.`,
  }
}

// ---------- attempt_payment (MPP-specific, no CLI exists) ----------

type PaymentOutcome = {
  paymentHash: string
  doneEvent: DoneEvent
  answerText: string
}

async function toolAttemptPayment(input: {
  chargeMethod: ReturnType<typeof charge>
  getChallenge: () => ChargeChallenge | null
  requestBody: string
  setOutcome: (outcome: PaymentOutcome) => void
}) {
  const { chargeMethod, getChallenge, requestBody, setOutcome } = input
  const challenge = getChallenge()
  if (!challenge) {
    return {
      ok: false,
      reason: 'No invoice captured yet -- call probe_invoice first to obtain the 402.',
    }
  }
  const label = decodeCurrencyCode(
    (JSON.parse(challenge.request.currency) as { currency: string }).currency,
  )

  let credentialHeader: string
  try {
    log.info(
      `Building MPP credential for ${challenge.request.amount} ${label} -> ${challenge.request.recipient}`,
    )
    credentialHeader = await chargeMethod.createCredential({
      challenge,
      context: { mode: 'pull' },
    })
  } catch (err: any) {
    return {
      ok: false,
      reason: `Credential build failed (likely insufficient ${label}): ${err.message}`,
    }
  }

  log.request('POST', '/complete', 'with Authorization (signed payment credential)')
  const response = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: credentialHeader },
    body: requestBody,
  })

  if (!response.ok) {
    const body = await response.text()
    log.response(response.status, 'payment rejected')
    return { ok: false, reason: `Marketplace returned ${response.status}: ${body}` }
  }
  if (!response.body) {
    return { ok: false, reason: 'Marketplace returned 200 with no body' }
  }
  log.response(200, 'payment accepted -- streaming the marketplace answer')

  let paymentHash = ''
  try {
    const receipt = Receipt.fromResponse(response)
    paymentHash = receipt.reference
    log.tx(paymentHash, log.explorerLink(paymentHash))
  } catch {
    // No Payment-Receipt header -- continue but report missing hash.
  }

  let done: DoneEvent | null = null
  const answerChunks: string[] = []
  log.info('Marketplace answer (streamed live):')
  process.stdout.write('   ')
  for await (const evt of readSseEvents(response.body)) {
    if (evt.event === 'token') {
      process.stdout.write(evt.data.value)
      answerChunks.push(evt.data.value)
    } else if (evt.event === 'done') {
      done = evt.data as DoneEvent
    } else if (evt.event === 'error') {
      process.stdout.write('\n')
      return { ok: false, reason: `Server stream error: ${evt.data.message}` }
    }
  }
  process.stdout.write('\n')

  if (!done) {
    return { ok: false, reason: 'Stream ended without a done event' }
  }

  setOutcome({ paymentHash, doneEvent: done, answerText: answerChunks.join('') })
  return {
    ok: true,
    payment_tx_hash: paymentHash || null,
    server_quote: done.paid,
    real_cost: done.actual_cost,
    overpayment: done.overpayment,
    currency_label: done.currency_label,
    note: 'Payment settled on-chain and the marketplace streamed the LLM answer. Your task is complete.',
  }
}

// ---------- Agent loop ----------

/** Render a tool call as a short, readable one-liner for the log. */
function describeToolCall(name: string, rawInput: unknown): string {
  if (name === 'xrpl_up') {
    const a = (rawInput as { args?: unknown }).args
    if (Array.isArray(a)) return `xrpl_up  (xrpl-up ${a.join(' ')})`
    return 'xrpl_up'
  }
  const json = JSON.stringify(rawInput ?? {})
  return json === '{}' ? name : `${name}  ${json}`
}

async function runAgent(input: {
  anthropic: Anthropic
  wallet: Wallet
  requestBody: string
  chargeMethod: ReturnType<typeof charge>
}): Promise<{ outcome: PaymentOutcome; challenge: ChargeChallenge }> {
  const { anthropic, wallet, requestBody, chargeMethod } = input

  let outcome: PaymentOutcome | null = null
  let challenge: ChargeChallenge | null = null

  const tools: Anthropic.Tool[] = [
    {
      name: 'probe_invoice',
      description:
        'Call the marketplace to obtain the invoice. POSTs /complete with no payment and ' +
        'returns the 402 challenge contents: how much you owe, the token you owe it in ' +
        '(currency code + issuer), and who to pay. This is the ONLY way to learn what is ' +
        'being charged -- nothing about the price or the token is known before you call it.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'open_trustline',
      description:
        'Open the trustline you need to be able to hold the token from the invoice, using ' +
        'the SDK in a single step (no CLI fiddling with currency hex / issuer / limit). It ' +
        'reads the token from the invoice you already fetched with probe_invoice. Call this ' +
        'once, after you know the token, before you try to acquire or hold it. Optionally ' +
        'pass a "limit".',
      input_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'string',
            description: 'Optional trustline limit (decimal string). Defaults to a sensible value.',
          },
        },
        required: [],
      },
    },
    {
      name: 'acquire_token',
      description:
        "Acquire enough of the invoice's token to pay it, by swapping your XRP on the " +
        'public on-chain AMM. It drives `xrpl-up` for both steps: `amm info` to discover ' +
        'the live XRP/<token> pool, then `payment` (a cross-currency Payment capped by ' +
        'SendMax) to execute the swap. It sizes the trade to cover the amount due (plus a ' +
        'small cushion) and reads the token + amount from the invoice you fetched. Use this ' +
        'to obtain the token instead of hand-building DEX/AMM/offer CLI commands yourself. ' +
        'Requires the trustline to be open first. Optionally pass "slippage_pct".',
      input_schema: {
        type: 'object',
        properties: {
          slippage_pct: {
            type: 'number',
            description: 'Optional slippage cushion in percent (default 5).',
          },
        },
        required: [],
      },
    },
    {
      name: 'xrpl_up',
      description:
        'Run ANY `xrpl-up` CLI command against the XRP Ledger and get its raw ' +
        'stdout/stderr/exit code back. Pass the arguments as an array of strings ' +
        '(everything you would type after `xrpl-up`), e.g. ' +
        '["account","balance","rEXAMPLE..."] or ["--help"] or ["amm","--help"]. ' +
        'The CLI is already pointed at the right network. Use this mainly to INSPECT the ' +
        'ledger and your account (balances, trust-lines, amm info, ...). For the two actions ' +
        'that matter here, prefer the dedicated SDK tools: open_trustline (trustline) and ' +
        'acquire_token (swap XRP -> the invoice token). Run `["--help"]` or ' +
        '`["<command>","--help"]` whenever you are unsure what a command does.',
      input_schema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'The xrpl-up arguments, tokenized as an array (no leading "xrpl-up").',
          },
        },
        required: ['args'],
      },
    },
    {
      name: 'attempt_payment',
      description:
        'Settle the marketplace invoice using the balance you currently hold of the token ' +
        'you owe. The script builds the MPP credential and POSTs /complete with ' +
        'Authorization. Returns {ok:true,...} on success, or {ok:false, reason} if it ' +
        'cannot be built/submitted (e.g. you do not yet hold enough of the token, or you ' +
        'have not fetched the invoice yet). Only call this once you believe you hold enough.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  ]

  // Deliberately minimal. The agent is told only its identity and what it
  // holds. It is told nothing about the amount, the token, the recipient,
  // or any market/pool/pair/price. It must call the marketplace to learn
  // what it owes, then work out how to obtain and pay it.
  const systemPrompt =
    'You are an autonomous on-chain payment agent driving a fresh XRPL testnet wallet.\n' +
    `Your wallet address is ${wallet.address}.\n` +
    'Your wallet currently holds ONLY native XRP (funded from the testnet faucet).\n\n' +
    'GOAL: obtain a paid result from a marketplace API. You do not yet know what it costs ' +
    'or in what token -- you must ASK it. Use probe_invoice to fetch the invoice (an HTTP 402): ' +
    'it tells you the amount, the token (currency code + issuer), and who to pay.\n\n' +
    'You will almost certainly be billed in a token you do NOT hold and CANNOT mint (you are ' +
    'not its issuer). You hold only XRP. Reason about what that implies: to pay a token you ' +
    'must actually hold it, which means (a) trusting its issuer and (b) acquiring the token by ' +
    'trading the XRP you do have. You are NOT told where or how to trade -- the XRP Ledger has ' +
    'an on-chain exchange; use the tools to discover for yourself what liquidity exists, size ' +
    'the trade with a small safety margin, execute it, and verify you received the token.\n\n' +
    'TOOLS:\n' +
    '- probe_invoice: ask the marketplace what you owe (returns amount + token + issuer + payee).\n' +
    '- open_trustline: open the trustline for the invoice token in ONE step via the SDK.\n' +
    '- acquire_token: swap your XRP for the invoice token on the public on-chain AMM in ONE ' +
    'step via the SDK (it finds the pool, sizes the trade, and caps the spend). Requires the ' +
    'trustline first.\n' +
    '- xrpl_up: run any `xrpl-up` CLI command, mainly to INSPECT the ledger / your account. ' +
    'You should not need it for the trustline or the swap -- use the dedicated tools above.\n' +
    '- attempt_payment: settle with the marketplace once you actually hold enough of the token.\n\n' +
    'The natural order is: probe_invoice -> open_trustline -> acquire_token -> attempt_payment. ' +
    'Work step by step. Before each tool call, briefly state your reasoning so a human can ' +
    'follow your decisions. Stop only when attempt_payment returns ok:true.'

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Get the paid result from the marketplace. Start by finding out what it charges, then ' +
        'do whatever is necessary to pay it. Think out loud and only stop when attempt_payment ' +
        'succeeds.',
    },
  ]

  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn++) {
    log.heading(`Agent turn ${turn}/${MAX_AGENT_TURNS}`)
    log.loading('Asking Claude what to do next...')
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    })

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    for (const tb of textBlocks) {
      if (tb.text.trim()) {
        log.agent(tb.text.trim())
      }
    }

    if (response.stop_reason === 'end_turn' && response.content.every((b) => b.type === 'text')) {
      if (outcome) break
      throw new Error('Agent stopped without succeeding -- last text shown above.')
    }

    messages.push({ role: 'assistant', content: response.content })

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    if (toolUses.length === 0) {
      if (outcome) break
      throw new Error('Agent stopped without calling a tool.')
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      log.tool(`Claude decided to call: ${describeToolCall(tu.name, tu.input)}`)
      let result: any
      try {
        if (tu.name === 'probe_invoice') {
          result = await toolProbeInvoice({
            requestBody,
            setChallenge: (c) => {
              challenge = c
            },
          })
        } else if (tu.name === 'open_trustline') {
          result = await toolOpenTrustline({
            wallet,
            getChallenge: () => challenge,
            limit: (tu.input as { limit?: unknown }).limit,
          })
        } else if (tu.name === 'acquire_token') {
          result = await toolAcquireToken({
            wallet,
            getChallenge: () => challenge,
            slippagePct: (tu.input as { slippage_pct?: unknown }).slippage_pct,
          })
        } else if (tu.name === 'xrpl_up') {
          result = await toolXrplUp({ wallet, args: (tu.input as { args: unknown }).args })
        } else if (tu.name === 'attempt_payment') {
          result = await toolAttemptPayment({
            chargeMethod,
            getChallenge: () => challenge,
            requestBody,
            setOutcome: (o) => {
              outcome = o
            },
          })
        } else {
          result = { error: `Unknown tool: ${tu.name}` }
        }
      } catch (err: any) {
        result = { error: err.message }
      }
      // For xrpl_up the full CLI output was already echoed above, so just
      // confirm the exit code; for the others, show the result the agent
      // will read on its next turn.
      if (tu.name === 'xrpl_up') {
        log.toolResult(`xrpl_up returned exit ${result?.exit_code ?? '?'} (output above)`)
      } else {
        log.toolResult(`${tu.name} returned: ${JSON.stringify(result).slice(0, 600)}`)
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      })
    }
    messages.push({ role: 'user', content: toolResults })

    if (outcome) {
      const wrap = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 256,
        system: systemPrompt,
        tools,
        messages,
      })
      const wrapText = wrap.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      if (wrapText) log.agent(`(wrap-up) ${wrapText}`)
      break
    }
  }

  if (!outcome) {
    throw new Error(`Agent did not succeed within ${MAX_AGENT_TURNS} turns.`)
  }
  if (!challenge) {
    throw new Error('Agent succeeded but no challenge was captured (should not happen).')
  }
  return { outcome, challenge }
}

// ---------- Main ----------

async function main() {
  log.box([
    'XRPL MPP -- LLM Marketplace (charge client, AUTONOMOUS: Claude calls, discovers + pays)',
  ])
  log.separator()

  const anthropic = createAnthropic()

  log.loading('Funding payer wallet via testnet faucet (XRP only)...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer (agent)', wallet.address)
  log.separator()

  // The ONLY thing the script reads up front is the bare identity probe,
  // purely to print a friendly header. It is not passed to the agent --
  // the agent will obtain everything monetary itself via probe_invoice.
  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('Marketplace recipient', info.recipient)
  log.info(`Model: ${info.model}`)
  log.info('Holds: native XRP only (from the faucet -- no RLUSD funding anywhere)')
  log.info(
    'The agent is told nothing: not the price, not the token, not the issuer, not the ' +
      'recipient, not any market. It must call the marketplace and work it all out.',
  )
  log.separator()

  const requestBody = JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS })

  const chargeMethod = charge({
    wallet,
    mode: 'pull',
    network: NETWORK,
    onProgress: (evt) => {
      if (evt.type === 'preflight') log.info('  (MPP) preflight...')
      else if (evt.type === 'pathfinding') log.info('  (MPP) ripple_path_find...')
      else if (evt.type === 'signing') log.info('  (MPP) signing the token Payment tx...')
      else if (evt.type === 'confirmed') log.info(`  (MPP) tx submitted: ${evt.hash}`)
    },
  })

  log.box([
    'Handing over to the agent.',
    '',
    'It is handed no map and no invoice. It will:',
    '  - POST the marketplace itself to discover what it owes (probe_invoice)',
    '  - open the trustline for whatever token that invoice names',
    '  - discover the on-chain liquidity and execute the swap',
    '  - settle the invoice',
    '',
    'Every `$ xrpl-up …` line below, and the /complete calls, are actions',
    'the agent chose. The script only executes what Claude asks for.',
  ])

  const { outcome, challenge } = await runAgent({
    anthropic,
    wallet,
    requestBody,
    chargeMethod,
  })

  log.separator()
  const label = outcome.doneEvent.currency_label
  const currencyWire = challenge.request.currency
  const overpayPct =
    Number(outcome.doneEvent.paid) > 0
      ? ((Number(outcome.doneEvent.overpayment) / Number(outcome.doneEvent.paid)) * 100).toFixed(1)
      : '0.0'

  // Final post-state balances -- read via the same CLI the agent used.
  const finalBalance = await toolXrplUp({
    wallet,
    args: ['account', 'balance', wallet.address, '--json'],
  })
  const finalLines = await toolXrplUp({
    wallet,
    args: ['account', 'trust-lines', wallet.address, '--json'],
  })

  log.box([
    'Settlement -- autonomous charge (Claude tool-use + xrpl-up CLI)',
    '',
    `Server quote:        ${formatAmount(outcome.doneEvent.paid, currencyWire, label)}`,
    `Actual cost:         ${formatAmount(outcome.doneEvent.actual_cost, currencyWire, label)}`,
    `Overpayment:         ${formatAmount(outcome.doneEvent.overpayment, currencyWire, label)} (${overpayPct}%)`,
    `Anthropic usage:     ${outcome.doneEvent.input_tokens} input + ${outcome.doneEvent.output_tokens} output tokens`,
    '',
    `Payment tx:          ${outcome.paymentHash || '(receipt header missing)'}`,
    '',
    'Final balances (xrpl-up account balance / trust-lines):',
    `   XRP:   ${(finalBalance as any).stdout ?? '(n/a)'}`,
    `   lines: ${(finalLines as any).stdout ?? '(n/a)'}`,
    '',
    'The agent was handed nothing: no invoice, no token, no issuer, no payee,',
    'no pool, no pair, no price. It called the marketplace itself to learn what',
    'it owed, opened the trustline, discovered the on-chain liquidity, sized and',
    'executed the swap, and settled -- all with free faucet XRP, never once',
    'funded with the token it ultimately paid in.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
