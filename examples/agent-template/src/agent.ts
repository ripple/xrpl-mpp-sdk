/**
 * The agent itself -- a Claude model with tool-use.
 *
 * What this file does, in plain English:
 *
 *   1. Receives a natural-language user request (e.g. "Write me the next
 *      LinkedIn post for our SDK launch...").
 *   2. Runs Claude with ONE tool exposed: `generate_linkedin_post(brief)`.
 *   3. Claude decides what `brief` to ship, then calls the tool.
 *   4. The tool calls our paid MPP service via callPostService(). mppx
 *      intercepts the 402 transparently, signs an XRPL Payment from the
 *      agent's wallet, the server validates it on-chain, then returns
 *      the generated post.
 *   5. We feed the tool result back into Claude so it can present the
 *      post to the user (with a one-line wrap-up).
 *
 * The whole loop is instrumented via the `onEvent` callback so the
 * orchestrator (run-demo.ts) can display the exchange step by step --
 * the request to Claude, Claude's reply text, the tool input, the
 * payment lifecycle, the response, and the final answer.
 */
import Anthropic from '@anthropic-ai/sdk'
import { type ChargeProgressEvent, fromDrops, type NetworkId, type Wallet } from 'xrpl-mpp-sdk'
import { attachPayer, type CallServiceResult, callPostService } from './client.js'
import { PostBrief } from './intent.js'

/** Anthropic tool schema. The keys mirror PostBrief from src/intent.ts. */
const LINKEDIN_TOOL: Anthropic.Tool = {
  name: 'generate_linkedin_post',
  description: [
    'Draft a single LinkedIn post via the paid LinkedIn-post marketplace API.',
    'Use this whenever the user asks you to write, draft, prepare, or compose',
    'a LinkedIn post. Each call costs a small amount of XRP on the XRPL',
    'testnet; budget accordingly via maxTokens.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      company: {
        type: 'string',
        description: 'Name of the company posting (e.g. "Acme Corp").',
      },
      product: {
        type: 'string',
        description: 'Concise description of the product, launch, or news to post about.',
      },
      audience: {
        type: 'string',
        description: 'Target LinkedIn audience (e.g. "AI agent builders, fintech engineers").',
      },
      tone: {
        type: 'string',
        enum: ['professional', 'enthusiastic', 'technical', 'visionary'],
        description: 'Voice of the post.',
      },
      keyPoints: {
        type: 'array',
        items: { type: 'string' },
        description: '1 to 8 bullet points the post must cover (one short sentence each).',
        minItems: 1,
        maxItems: 8,
      },
      callToAction: {
        type: 'string',
        description: 'Optional final-line CTA (e.g. "Try the demo at github.com/...").',
      },
      maxTokens: {
        type: 'integer',
        description:
          'Worst-case output token budget for the post generation. Higher = more spend. ' +
          'A short punchy LinkedIn post needs ~300-500 tokens.',
        minimum: 64,
        maximum: 4000,
      },
    },
    required: ['company', 'product', 'audience', 'keyPoints', 'maxTokens'],
  },
}

const SYSTEM_PROMPT = [
  'You are an AI agent embedded in a Node.js process.',
  'You have access to ONE paid tool: generate_linkedin_post.',
  'When the user asks for a LinkedIn post, you MUST call that tool exactly',
  'once with a well-thought-out brief. Do not invent the post text yourself --',
  "the tool's job is to return the final post.",
  'After the tool returns, present the post verbatim to the user inside a',
  'fenced code block, followed by ONE short sentence noting that the',
  'on-chain XRPL payment settled and the receipt is attached.',
].join(' ')

export type AgentArgs = {
  serverUrl: string
  payer: Wallet
  network: NetworkId
  anthropicApiKey: string
  model: string
  userRequest: string
  /** Hard cap on tool-use rounds. Defaults to 4. */
  maxToolRounds?: number
  /**
   * Optional logger called at each step. Useful for the run-demo CLI; the
   * core agent works fine without it.
   */
  onEvent?: (evt: AgentEvent) => void
}

export type AgentEvent =
  /** Claude API call about to be made. */
  | { type: 'claude_call'; round: number; messageCount: number }
  /** Claude returned a text block this turn (reasoning or answer). */
  | { type: 'claude_text'; round: number; text: string }
  /** Claude wants to invoke a tool. */
  | { type: 'tool_call'; name: string; input: unknown }
  /** About to POST the brief to the paid service. */
  | { type: 'http_send'; url: string; byteCount: number }
  /** mppx is doing something behind the patched fetch (sign, submit, ...). */
  | { type: 'payment_progress'; progress: ChargeProgressEvent }
  /** Got the final HTTP response back from the paid service. */
  | {
      type: 'http_receive'
      status: number
      ms: number
      receipt?: { reference: string; explorerUrl: string }
      paid?: { amountDrops: string; amountXrp: string; currency: string }
    }
  /** Full tool execution result, after both the HTTP call and any error mapping. */
  | { type: 'tool_result'; name: string; result: CallServiceResult }
  /** About to feed the tool result back to Claude for synthesis. */
  | { type: 'tool_result_to_claude'; round: number; summaryByteCount: number }
  /** Claude finished -- no more tool calls expected. */
  | { type: 'agent_finished'; rounds: number }

export type AgentRunResult = {
  finalText: string
  toolCalls: Array<{ input: unknown; result: CallServiceResult }>
  totalDropsSpent: bigint
  receipts: Array<{ reference: string; explorerUrl: string }>
  rounds: number
}

/**
 * Run one turn of the agent. Internally loops on tool_use until Claude
 * stops calling tools (or we hit maxToolRounds).
 */
export async function runAgent(args: AgentArgs): Promise<AgentRunResult> {
  // One call builds a client that auto-pays an MPP 402. It is scoped to this
  // agent rather than installed over globalThis.fetch, so nothing else in the
  // process starts paying by accident. Forward every lifecycle event so the
  // demo can show what's happening behind it.
  const mppx = attachPayer(args.payer, args.network, {
    onPaymentProgress: (progress) => args.onEvent?.({ type: 'payment_progress', progress }),
  })

  const anthropic = new Anthropic({ apiKey: args.anthropicApiKey })
  const maxRounds = args.maxToolRounds ?? 4

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: args.userRequest }]

  const toolCalls: AgentRunResult['toolCalls'] = []
  let totalDropsSpent = 0n
  const receipts: AgentRunResult['receipts'] = []
  let finalText = ''
  let lastRound = 0

  for (let round = 1; round <= maxRounds; round++) {
    lastRound = round
    args.onEvent?.({ type: 'claude_call', round, messageCount: messages.length })

    const response = await anthropic.messages.create({
      model: args.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [LINKEDIN_TOOL],
      messages,
    })

    // Surface any text Claude emitted this turn (could be reasoning or the
    // final answer if no tool was called).
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    const roundText = textBlocks
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (roundText) {
      args.onEvent?.({ type: 'claude_text', round, text: roundText })
      finalText = roundText
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    // No tool calls -> Claude is done, return its text as the final answer.
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      args.onEvent?.({ type: 'agent_finished', rounds: round })
      return { finalText, toolCalls, totalDropsSpent, receipts, rounds: round }
    }

    // Echo the assistant turn back into the conversation so subsequent
    // turns see the tool_use blocks they're replying to.
    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      if (use.name !== LINKEDIN_TOOL.name) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Unknown tool "${use.name}".`,
        })
        continue
      }

      const parsed = PostBrief.safeParse(use.input)
      if (!parsed.success) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Brief validation failed: ${JSON.stringify(parsed.error.issues)}`,
        })
        continue
      }

      args.onEvent?.({ type: 'tool_call', name: use.name, input: parsed.data })

      const briefBytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
      const url = `${args.serverUrl}/linkedin-post`
      args.onEvent?.({ type: 'http_send', url, byteCount: briefBytes })

      const t0 = Date.now()
      const callResult = await callPostService({
        serverUrl: args.serverUrl,
        brief: parsed.data,
        mppx,
      })
      const ms = Date.now() - t0

      args.onEvent?.({
        type: 'http_receive',
        status: callResult.status,
        ms,
        ...(callResult.receipt && { receipt: callResult.receipt }),
        ...(callResult.paid && { paid: callResult.paid }),
      })
      args.onEvent?.({ type: 'tool_result', name: use.name, result: callResult })
      toolCalls.push({ input: parsed.data, result: callResult })

      if (callResult.paid) {
        try {
          totalDropsSpent += BigInt(callResult.paid.amountDrops)
        } catch {
          // amountDrops should always be a stringified integer -- skip on parse error.
        }
      }
      if (callResult.receipt) {
        receipts.push({
          reference: callResult.receipt.reference,
          explorerUrl: callResult.receipt.explorerUrl,
        })
      }

      // Feed the post back to Claude. We give it only the human-readable
      // text + minimal metadata -- not the full receipt payload, which is
      // for our records, not the model's.
      const summary = callResult.ok
        ? {
            ok: true,
            post: callResult.post?.text ?? '',
            characterCount: callResult.post?.characterCount,
            hashtags: callResult.post?.hashtags,
            paid: callResult.paid,
          }
        : { ok: false, status: callResult.status, error: callResult.body }
      const summaryJson = JSON.stringify(summary)

      args.onEvent?.({
        type: 'tool_result_to_claude',
        round,
        summaryByteCount: Buffer.byteLength(summaryJson, 'utf8'),
      })

      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        is_error: !callResult.ok,
        content: summaryJson,
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  // Loop budget exceeded -- return whatever we last got from the model.
  args.onEvent?.({ type: 'agent_finished', rounds: lastRound })
  return { finalText, toolCalls, totalDropsSpent, receipts, rounds: lastRound }
}

// ---------------------------------------------------------------------------
// CLI entry: `tsx src/agent.ts "your request here"`
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { loadConfig, loadWallets } = await import('./env.js')
  const log = await import('./log.js')
  const { fromDrops } = await import('xrpl-mpp-sdk')

  const config = loadConfig({ requireAnthropic: true })

  log.header(
    'XRPL MPP -- AI Agent (standalone CLI)',
    'Claude agent paying a Claude-backed service on testnet',
  )
  log.kv([
    ['network', config.network],
    ['server', config.serverUrl],
    ['model', config.anthropicModel],
  ])

  log.step(1, 2, "funding the agent's payer wallet (testnet faucet)")
  const { payer } = await loadWallets('payer', config.network)
  if (!payer) throw new Error('Failed to load payer wallet')
  log.line('agent', `payer: ${payer.address}`)

  const userRequest =
    process.argv.slice(2).join(' ').trim() ||
    'Write the next LinkedIn post announcing our company release of the xrpl-mpp-sdk: ' +
      'an open-source TypeScript SDK that lets AI agents pay for any HTTP API on the ' +
      'XRP Ledger via the Machine Payments Protocol (MPP / HTTP 402). Audience: AI agent ' +
      'builders and fintech engineers. Tone: enthusiastic.'

  log.step(2, 2, 'running the Claude agent')
  log.divider('user request')
  log.quote(userRequest)
  log.divider()

  const result = await runAgent({
    serverUrl: config.serverUrl,
    payer,
    network: config.network,
    anthropicApiKey: config.anthropicApiKey!,
    model: config.anthropicModel,
    userRequest,
    onEvent: (e) => renderAgentEvent(e, log),
  })

  log.blank()
  log.divider("Claude's final answer to the user")
  log.quote(result.finalText || '(no final text)')
  log.divider()

  if (result.receipts.length > 0) {
    log.blank()
    log.line(
      'demo',
      `total spent: ${result.totalDropsSpent} drops ` +
        `(${fromDrops(result.totalDropsSpent.toString())} XRP) across ${result.toolCalls.length} call(s)`,
    )
    for (const r of result.receipts) {
      log.line('demo', `tx ${r.reference}`)
      log.line('demo', `   ${r.explorerUrl}`)
    }
  }
}

/**
 * Pretty-print an `AgentEvent`. Shared between the CLI here and the
 * orchestrator in run-demo.ts so both surfaces look identical.
 */
export function renderAgentEvent(e: AgentEvent, log: typeof import('./log.js')): void {
  switch (e.type) {
    case 'claude_call':
      log.arrow(
        'agent',
        '->',
        `anthropic.messages.create (round ${e.round}, ${e.messageCount} message(s) in context)`,
      )
      break
    case 'claude_text':
      log.arrow('agent', '<-', `Claude replied with text (round ${e.round}):`)
      log.quote(e.text)
      break
    case 'tool_call':
      log.arrow('agent', '..', `Claude decided to call tool: ${e.name}`)
      log.divider('tool input (brief)')
      renderBriefKv(e.input, log)
      log.divider()
      break
    case 'http_send':
      log.arrow('agent', '->', `POST ${e.url}  (brief ${e.byteCount}B)`)
      break
    case 'payment_progress':
      log.arrow('agent', '..', formatPaymentProgress(e.progress))
      break
    case 'http_receive': {
      const okStr = e.status === 200 ? 'OK' : `FAIL ${e.status}`
      const paidStr = e.paid ? `  paid=${e.paid.amountXrp} XRP` : ''
      const recStr = e.receipt ? `  tx=${log.shorten(e.receipt.reference, 8, 8)}` : ''
      log.arrow('agent', '<-', `${okStr}  (${e.ms}ms)${paidStr}${recStr}`)
      if (e.receipt) log.line('agent', `   ${log.dim(e.receipt.explorerUrl)}`)
      break
    }
    case 'tool_result':
      // Already covered by http_receive -- skip to avoid noise.
      break
    case 'tool_result_to_claude':
      log.arrow(
        'agent',
        '->',
        `feeding tool_result back to Claude (round ${e.round}, ${e.summaryByteCount}B summary)`,
      )
      break
    case 'agent_finished':
      log.arrow(
        'agent',
        '..',
        `Claude returned without calling a new tool -- loop ends after ${e.rounds} round(s)`,
      )
      break
  }
}

function renderBriefKv(input: unknown, log: typeof import('./log.js')): void {
  if (!input || typeof input !== 'object') {
    log.quote(JSON.stringify(input, null, 2))
    return
  }
  const i = input as Record<string, unknown>
  const pairs: Array<[string, string]> = []
  if (typeof i.company === 'string') pairs.push(['company', i.company])
  if (typeof i.product === 'string') pairs.push(['product', truncate(i.product, 80)])
  if (typeof i.audience === 'string') pairs.push(['audience', i.audience])
  if (typeof i.tone === 'string') pairs.push(['tone', i.tone])
  if (Array.isArray(i.keyPoints)) pairs.push(['keyPoints', `${i.keyPoints.length} item(s)`])
  if (typeof i.callToAction === 'string') pairs.push(['callToAction', truncate(i.callToAction, 80)])
  if (typeof i.maxTokens === 'number') pairs.push(['maxTokens', String(i.maxTokens)])
  log.kv(pairs)
  if (Array.isArray(i.keyPoints)) {
    for (const [idx, p] of i.keyPoints.entries()) {
      log.line('agent', `   ${idx + 1}. ${truncate(String(p), 90)}`)
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}...`
}

function formatPaymentProgress(p: ChargeProgressEvent): string {
  switch (p.type) {
    case 'challenge': {
      const amount =
        p.currency === 'XRP'
          ? `${p.amount} drops (${fromDrops(p.amount)} XRP)`
          : `${p.amount} ${p.currency}`
      return `[mppx] 402 challenge parsed: pay ${amount} to ${p.recipient}`
    }
    case 'preflight':
      return `[mppx] preflight -- checking payer balance + destination exists`
    case 'pathfinding':
      return `[mppx] ripple_path_find -- resolving IOU payment path`
    case 'paths_resolved':
      return (
        `[mppx] path resolved via ${p.strategy}: ` +
        `source amount ${p.sourceAmountValue} ${p.sourceAmountCurrency}`
      )
    case 'signing':
      return `[mppx] signing the Payment transaction locally`
    case 'signed':
      return `[mppx] signed -- shipping the blob via ${p.mode} mode (server will submit)`
    case 'submitting':
      return `[mppx] submitting the signed tx directly to XRPL (push mode)`
    case 'confirmed':
      return `[mppx] tx confirmed on-chain: ${p.hash}`
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error('[agent] fatal:', err)
    process.exit(1)
  })
}
