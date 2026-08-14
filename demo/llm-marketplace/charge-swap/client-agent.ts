/**
 * LLM Marketplace -- Charge mode (single IOU) -- Agentic client
 *
 * Same wire shape as ./client.ts but the *decision-making* is genuinely
 * agentic: Claude is given a set of tools (Anthropic tool-use) and a
 * goal, and decides by itself which tool to call at each step. The
 * companion script (this file) only:
 *   - bootstraps the wallet + trustlines + USD allowance
 *   - probes the marketplace once to capture the 402 challenge
 *   - hands the challenge to the LLM as context
 *   - executes the tools the LLM picks (via the `xrpl-up` CLI)
 *   - on a successful `attempt_payment`, runs the actual MPP credential
 *     dance against the marketplace
 *
 * Every action that hits the XRPL is performed by shelling out to the
 * `xrpl-up` CLI -- so you can SEE, in the terminal, each command the
 * agent decided to run:
 *
 *   - `xrpl-up amm info ...`               (query the USD/CRD pool)
 *   - `xrpl-up account trust-lines ...`    (read IOU balances)
 *   - `xrpl-up payment ...`                (cross-currency swap)
 *
 * The MPP-specific bit (build the credential, POST /complete with
 * Authorization, stream SSE) is NOT exposed as a CLI command -- there
 * is no MPP CLI yet -- so the script wraps it as the `attempt_payment`
 * tool. From Claude's perspective the tool is just "try to pay the
 * marketplace now" and the result is "succeeded / failed because X".
 *
 * Run: npx tsx demo/llm-marketplace/charge-swap/client-agent.ts
 *      (after `npx tsx demo/llm-marketplace/charge-swap/server.ts`)
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { Challenge, Receipt } from 'mppx'
import { charge } from '../../../sdk/src/client/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { createAnthropic, MODEL } from '../shared/anthropic.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3011
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const PROMPT = 'Explain in one short paragraph why agents need on-chain DEX access.'
const MAX_TOKENS = 120

/** Path to the `xrpl-up` binary installed locally as a devDependency. */
const XRPL_UP = resolve(process.cwd(), 'node_modules/.bin/xrpl-up')

/** Hard cap on agent tool-use turns; safety net against runaway loops. */
const MAX_AGENT_TURNS = 8

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

// ---------- Shell wrapper around xrpl-up ----------

/**
 * Run an `xrpl-up` invocation and return its stdout/stderr/exit code.
 * Streams both to the demo log so the user can SEE the agent's tool
 * calls and outputs as they happen.
 */
function runXrplUp(
  args: string[],
  options: { hideArgs?: string[] } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const visibleArgs = args.map((a, i) => {
    // Redact sensitive positional values (seeds) in the log.
    const previous = args[i - 1]
    if (options.hideArgs?.includes(previous)) return '***'
    return a
  })
  log.info(`$ xrpl-up ${visibleArgs.join(' ')}`)
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

// ---------- HTTP helpers (mirror client.ts) ----------

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

// ---------- Tool implementations (each shells out to xrpl-up) ----------

/**
 * Read both IOU balances of the agent via `xrpl-up account trust-lines`.
 * Returns a compact JSON object the LLM can reason about directly.
 */
async function toolCheckBalances(input: { walletAddress: string; info: Info }) {
  const { walletAddress, info } = input
  const res = await runXrplUp([
    'account',
    'trust-lines',
    walletAddress,
    '--node',
    NETWORK,
    '--json',
  ])
  if (res.exitCode !== 0) {
    return {
      error: `xrpl-up account trust-lines failed: ${res.stderr.trim() || res.stdout.trim()}`,
    }
  }
  const lines = JSON.parse(res.stdout) as Array<{
    currency: string
    account: string // peer (= issuer for the holder side)
    balance: string
    limit: string
  }>
  const usdLine = lines.find(
    (l) =>
      l.currency === info.bootstrapCurrency.currency && l.account === info.bootstrapCurrency.issuer,
  )
  const credLine = lines.find(
    (l) => l.currency === info.chargeCurrency.currency && l.account === info.chargeCurrency.issuer,
  )
  return {
    [info.bootstrapCurrencyLabel]: usdLine?.balance ?? '0',
    [info.chargeCurrencyLabel]: credLine?.balance ?? '0',
  }
}

/**
 * Read the USD/CRD AMM pool depth via `xrpl-up amm info --json`. The
 * LLM gets the raw reserves + trading fee and is expected to do the
 * (X*dy)/((Y-dy)*(1-fee)) math itself for the swap quote -- the goal
 * is to put as much reasoning as possible in the agent, not the script.
 */
async function toolQueryAmm(input: { info: Info }) {
  const { info } = input
  const assetA = `${info.bootstrapCurrency.currency}/${info.bootstrapCurrency.issuer}`
  const assetB = `${info.chargeCurrency.currency}/${info.chargeCurrency.issuer}`
  const res = await runXrplUp([
    'amm',
    'info',
    '--asset',
    assetA,
    '--asset2',
    assetB,
    '--node',
    NETWORK,
    '--json',
  ])
  if (res.exitCode !== 0) {
    return { error: `xrpl-up amm info failed: ${res.stderr.trim() || res.stdout.trim()}` }
  }
  const raw = JSON.parse(res.stdout) as any
  const amm = raw?.amm ?? raw
  const sideA = amm.amount
  const sideB = amm.amount2
  const sideACurrency = typeof sideA === 'object' ? sideA.currency : 'XRP'
  const usdSide = sideACurrency === info.bootstrapCurrency.currency ? sideA : sideB
  const credSide = sideACurrency === info.bootstrapCurrency.currency ? sideB : sideA
  return {
    pool_account: amm.account,
    [`${info.bootstrapCurrencyLabel}_reserve`]: usdSide.value,
    [`${info.chargeCurrencyLabel}_reserve`]: credSide.value,
    trading_fee_units: amm.trading_fee,
    trading_fee_percent: amm.trading_fee / 1000,
    hint:
      'Constant-product swap math: to receive dy CRD, USD-in ≈ ' +
      '(X*dy / (Y-dy)) / (1 - fee_fraction), where X=USD_reserve, Y=CRD_reserve.',
  }
}

/**
 * Submit a cross-currency Payment self -> self via `xrpl-up payment`,
 * with `Amount` in CRD and `--send-max` in USD. The agent decides both
 * the target CRD amount and the USD cap (slippage band).
 */
async function toolSwapUsdToCred(input: {
  wallet: Wallet
  info: Info
  target_cred: string
  usd_max: string
}) {
  const { wallet, info, target_cred, usd_max } = input
  const credAmount = `${target_cred}/${info.chargeCurrency.currency}/${info.chargeCurrency.issuer}`
  const usdAmount = `${usd_max}/${info.bootstrapCurrency.currency}/${info.bootstrapCurrency.issuer}`
  if (!wallet.seed) {
    return { error: 'Wallet has no exportable seed -- cannot delegate signing to xrpl-up.' }
  }
  const res = await runXrplUp(
    [
      'payment',
      '--to',
      wallet.address,
      '--amount',
      credAmount,
      '--send-max',
      usdAmount,
      '--seed',
      wallet.seed,
      '--node',
      NETWORK,
      '--json',
    ],
    { hideArgs: ['--seed'] },
  )
  if (res.exitCode !== 0) {
    return {
      error: `xrpl-up payment failed: ${res.stderr.trim() || res.stdout.trim()}`,
    }
  }
  // xrpl-up payment --json prints { hash, result, ... }. Parse defensively.
  let parsed: any
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    return { ok: true, output: res.stdout.trim() }
  }
  const txHash = parsed?.hash ?? parsed?.tx_hash ?? parsed?.result?.hash
  const meta = parsed?.meta ?? parsed?.result?.meta
  const txResult = meta?.TransactionResult ?? parsed?.result?.engine_result ?? parsed?.engine_result
  if (txResult && txResult !== 'tesSUCCESS') {
    return { error: `Swap rejected by ledger: ${txResult} (hash ${txHash})` }
  }
  if (txHash) {
    log.tx(txHash, log.explorerLink(txHash))
  }
  return {
    ok: true,
    tx_hash: txHash,
    explorer_url: txHash ? log.explorerLink(txHash) : undefined,
    note: `Swap settled: at most ${usd_max} USD spent for ${target_cred} CRD.`,
  }
}

/**
 * "Try to pay the marketplace now". This is the only tool the script
 * implements directly (no MPP CLI exists). On success it captures the
 * payment hash + the SSE done event in the `outcome` closure variable,
 * which the main flow reads after the agent loop ends.
 */
type PaymentOutcome = {
  paymentHash: string
  doneEvent: DoneEvent
  answerText: string
}

async function toolAttemptPayment(input: {
  chargeMethod: ReturnType<typeof charge>
  challenge: ChargeChallenge
  requestBody: string
  info: Info
  onAnswerToken: (token: string) => void
  setOutcome: (outcome: PaymentOutcome) => void
}) {
  const { chargeMethod, challenge, requestBody, info, onAnswerToken, setOutcome } = input
  let credentialHeader: string
  try {
    log.info(
      `Building MPP credential for ${challenge.request.amount} ${info.chargeCurrencyLabel} ` +
        '-> marketplace recipient',
    )
    credentialHeader = await chargeMethod.createCredential({
      challenge,
      context: { mode: 'pull' },
    })
  } catch (err: any) {
    return {
      ok: false,
      reason: `Credential build failed (likely insufficient ${info.chargeCurrencyLabel}): ${err.message}`,
    }
  }

  log.info(`POST ${BASE}/complete (with Authorization)`)
  const response = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: credentialHeader },
    body: requestBody,
  })

  if (!response.ok) {
    const body = await response.text()
    return { ok: false, reason: `Marketplace returned ${response.status}: ${body}` }
  }
  if (!response.body) {
    return { ok: false, reason: 'Marketplace returned 200 with no body' }
  }

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
  log.info('Streaming Anthropic tokens (visible to user):')
  process.stdout.write('   ')
  for await (const evt of readSseEvents(response.body)) {
    if (evt.event === 'token') {
      process.stdout.write(evt.data.value)
      answerChunks.push(evt.data.value)
      onAnswerToken(evt.data.value)
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

async function runAgent(input: {
  anthropic: Anthropic
  wallet: Wallet
  info: Info
  challenge: ChargeChallenge
  requestBody: string
  chargeMethod: ReturnType<typeof charge>
}): Promise<PaymentOutcome> {
  const { anthropic, wallet, info, challenge, requestBody, chargeMethod } = input

  let outcome: PaymentOutcome | null = null
  const tools: Anthropic.Tool[] = [
    {
      name: 'check_balances',
      description:
        `Read the agent's current ${info.bootstrapCurrencyLabel} and ${info.chargeCurrencyLabel} ` +
        'balances on-chain (`xrpl-up account trust-lines`). ' +
        'Useful before deciding whether to swap, and to verify a swap landed.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'query_amm',
      description:
        `Query the testnet ${info.bootstrapCurrencyLabel}/${info.chargeCurrencyLabel} AMM pool ` +
        '(`xrpl-up amm info`). Returns current reserves and trading fee. ' +
        'Use this BEFORE swap_usd_to_cred to size your swap correctly.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'swap_usd_to_cred',
      description:
        `Swap ${info.bootstrapCurrencyLabel} for ${info.chargeCurrencyLabel} via the AMM ` +
        '(`xrpl-up payment` with `--amount CRD` + `--send-max USD`). ' +
        'You specify the exact CRD you want to receive and the maximum USD you are willing to spend.',
      input_schema: {
        type: 'object',
        properties: {
          target_cred: {
            type: 'string',
            description: `Exact ${info.chargeCurrencyLabel} amount to receive (decimal string, e.g. "0.0623").`,
          },
          usd_max: {
            type: 'string',
            description: `Maximum ${info.bootstrapCurrencyLabel} you'll spend (decimal string). Include a slippage buffer.`,
          },
        },
        required: ['target_cred', 'usd_max'],
      },
    },
    {
      name: 'attempt_payment',
      description:
        'Try to honor the marketplace 402 challenge using your current ' +
        `${info.chargeCurrencyLabel} balance. The script builds the MPP credential and retries ` +
        '/complete with Authorization. Returns {ok:true,...} on success, or {ok:false, reason} ' +
        `if the payment cannot be built/submitted (e.g. insufficient ${info.chargeCurrencyLabel}).`,
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  ]

  const systemPrompt =
    'You are an autonomous on-chain payment agent. ' +
    `Your goal is to honor the marketplace's 402 challenge: pay exactly ${challenge.request.amount} ` +
    `${info.chargeCurrencyLabel} to recipient ${info.recipient}. ` +
    `You currently hold ${info.bootstrapCurrencyLabel} (USD-pegged IOU from the same issuer ` +
    `${info.bootstrapCurrency.issuer}) but no ${info.chargeCurrencyLabel}. ` +
    `To obtain ${info.chargeCurrencyLabel} you must swap your ${info.bootstrapCurrencyLabel} on the ` +
    `testnet DEX. You are NOT told where the liquidity is -- you only know the token PAIR ` +
    `(${info.bootstrapCurrencyLabel}/${info.chargeCurrencyLabel}); use query_amm to discover the ` +
    'pool and its depth on-chain before swapping. ' +
    'You have four tools: check_balances, query_amm, swap_usd_to_cred, attempt_payment. ' +
    'Plan, call tools, and stop only when attempt_payment returns ok:true. ' +
    'Be efficient: do not query the AMM repeatedly without reason. ' +
    'When sizing your swap, include a small slippage buffer (~5%) on top of the AMM-quoted USD cost. ' +
    'Reply with brief reasoning before each tool call so the human can follow your decisions.'

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Pay the marketplace 402 challenge now. Take it step by step: think out loud, ' +
        'call the tools you need, and only stop when attempt_payment succeeds.',
    },
  ]

  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn++) {
    log.separator()
    log.info(`Agent turn ${turn}/${MAX_AGENT_TURNS} -- asking Claude...`)
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    })

    // Print Claude's text reasoning, if any.
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    for (const tb of textBlocks) {
      if (tb.text.trim()) {
        log.info(`Claude: ${tb.text.trim()}`)
      }
    }

    if (response.stop_reason === 'end_turn' && response.content.every((b) => b.type === 'text')) {
      // Claude decided to stop without calling a tool. Either we already
      // succeeded (outcome set) or it gave up.
      if (outcome) break
      throw new Error('Agent stopped without succeeding -- last text shown above.')
    }

    // Append the assistant message as-is (includes any tool_use blocks).
    messages.push({ role: 'assistant', content: response.content })

    // Execute each tool_use block and feed back tool_results in one user message.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    if (toolUses.length === 0) {
      if (outcome) break
      throw new Error('Agent stopped without calling a tool.')
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      log.info(`Claude calls tool: ${tu.name}  input=${JSON.stringify(tu.input)}`)
      let result: any
      try {
        if (tu.name === 'check_balances') {
          result = await toolCheckBalances({ walletAddress: wallet.address, info })
        } else if (tu.name === 'query_amm') {
          result = await toolQueryAmm({ info })
        } else if (tu.name === 'swap_usd_to_cred') {
          const args = tu.input as { target_cred: string; usd_max: string }
          result = await toolSwapUsdToCred({
            wallet,
            info,
            target_cred: args.target_cred,
            usd_max: args.usd_max,
          })
        } else if (tu.name === 'attempt_payment') {
          result = await toolAttemptPayment({
            chargeMethod,
            challenge,
            requestBody,
            info,
            onAnswerToken: () => {},
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
      log.info(`tool result (${tu.name}): ${JSON.stringify(result).slice(0, 240)}`)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      })
    }
    messages.push({ role: 'user', content: toolResults })

    if (outcome) {
      // attempt_payment succeeded -- run one more turn so Claude can
      // summarize, then we exit.
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
      if (wrapText) log.info(`Claude (wrap-up): ${wrapText}`)
      break
    }
  }

  if (!outcome) {
    throw new Error(`Agent did not succeed within ${MAX_AGENT_TURNS} turns.`)
  }
  return outcome
}

// ---------- Main ----------

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, AGENTIC: Claude decides + xrpl-up tools)'])
  log.separator()

  const anthropic = createAnthropic()

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
  log.info(`Bootstrap (faucet): ${info.bootstrapCurrencyLabel}`)
  log.info(
    `DEX pool address: not advertised -- agent must discover it from the ` +
      `${info.bootstrapCurrencyLabel}/${info.chargeCurrencyLabel} pair`,
  )
  log.separator()

  log.loading(
    `Opening trustlines: payer accepts ${info.bootstrapCurrencyLabel} and ${info.chargeCurrencyLabel}...`,
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
      `(marketplace only takes ${info.chargeCurrencyLabel} -- the agent will figure it out)`,
  )
  log.separator()

  // Probe /complete once to capture the 402 challenge that the agent
  // will have to honor. We don't tell the agent anything the script
  // wouldn't tell it -- only the challenge contents, the available
  // tools, and what its wallet holds.
  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading(`POST ${BASE}/complete -- probing for the 402 challenge...`)
  const requestBody = JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS })
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
  const challenge = offers[0]
  log.challenge(
    `402 captured: ${formatAmount(challenge.request.amount, challenge.request.currency, info.chargeCurrencyLabel)}`,
  )
  log.separator()

  const chargeMethod = charge({
    wallet,
    mode: 'pull',
    network: NETWORK,
    onProgress: (evt) => {
      if (evt.type === 'preflight') log.info('  (MPP) preflight...')
      else if (evt.type === 'pathfinding') log.info('  (MPP) ripple_path_find...')
      else if (evt.type === 'signing') log.info('  (MPP) signing the CRD Payment tx...')
      else if (evt.type === 'confirmed') log.info(`  (MPP) tx submitted: ${evt.hash}`)
    },
  })

  log.box([
    'Handing over to the agent.',
    '',
    'From here on, EVERY decision is made by Claude:',
    '  - which tool to call',
    '  - how much to swap (target CRD + USD slippage band)',
    '  - when to attempt the payment',
    '',
    'Watch the `$ xrpl-up …` lines below: each is a command Claude',
    'decided to issue. The script only executes what Claude asks for.',
  ])

  const outcome = await runAgent({
    anthropic,
    wallet,
    info,
    challenge,
    requestBody,
    chargeMethod,
  })

  log.separator()
  const overpayPct =
    Number(outcome.doneEvent.paid) > 0
      ? ((Number(outcome.doneEvent.overpayment) / Number(outcome.doneEvent.paid)) * 100).toFixed(1)
      : '0.0'

  // Final post-state balances via xrpl-up so the user sees the agent's
  // tool surface one more time even after success.
  const finalBalances = await toolCheckBalances({ walletAddress: wallet.address, info })

  log.box([
    'Settlement -- agentic charge (Claude tool-use + xrpl-up CLI)',
    '',
    `Server quote:        ${formatAmount(outcome.doneEvent.paid, challenge.request.currency, info.chargeCurrencyLabel)}`,
    `Actual cost:         ${formatAmount(outcome.doneEvent.actual_cost, challenge.request.currency, info.chargeCurrencyLabel)}`,
    `Overpayment:         ${formatAmount(outcome.doneEvent.overpayment, challenge.request.currency, info.chargeCurrencyLabel)} (${overpayPct}%)`,
    `Anthropic usage:     ${outcome.doneEvent.input_tokens} input + ${outcome.doneEvent.output_tokens} output tokens`,
    '',
    `Payment tx:          ${outcome.paymentHash || '(receipt header missing)'}`,
    '',
    'Final balances (via `xrpl-up account trust-lines`):',
    `   ${info.bootstrapCurrencyLabel}: ${(finalBalances as any)[info.bootstrapCurrencyLabel]}`,
    `   ${info.chargeCurrencyLabel}: ${(finalBalances as any)[info.chargeCurrencyLabel]}`,
    '',
    'Every XRPL-touching operation in this run -- balance reads, AMM',
    'queries, and the swap itself -- was performed by Claude invoking',
    '`xrpl-up` through the tool-use API. The script never decided what to',
    'do; it only executed the commands the agent asked for.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
