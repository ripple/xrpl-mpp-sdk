import type Anthropic from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Wallet } from 'xrpl-mpp-sdk'
import { runAgent } from '../src/agent.js'
import { callPostService, type Payer } from '../src/client.js'

/**
 * The agent loop, driven offline: a scripted model and a fake payer.
 *
 * `modelCreate` stands in for `anthropic.messages.create` and answers from the
 * `replies` queue. The real `callPostService` runs (it is the tool), but the
 * payer under it is fake: each POST it receives counts as one settled payment
 * and is answered with a numbered post. Nothing touches Anthropic or a ledger.
 */
const { modelCreate, payerFetch } = vi.hoisted(() => ({
  modelCreate: vi.fn(),
  payerFetch: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: modelCreate }
  },
}))

vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>()
  return {
    ...actual,
    attachPayer: vi.fn(() => ({ fetch: payerFetch }) as unknown as Payer),
    callPostService: vi.fn(actual.callPostService),
  }
})

const PRICE_DROPS = 400_000n

const BRIEF = {
  company: 'Acme',
  product: 'An SDK that lets agents pay for APIs',
  audience: 'AI agent builders',
  tone: 'enthusiastic',
  keyPoints: ['Pays per call over HTTP 402'],
  maxTokens: 400,
}

let replies: Anthropic.Message[]
let payments: number
/** HTTP status the fake service answers with after it has been paid. */
let serviceStatus: number

function toolUse(id: string, preamble?: string): Anthropic.Message {
  return {
    stop_reason: 'tool_use',
    content: [
      ...(preamble ? [{ type: 'text', text: preamble }] : []),
      { type: 'tool_use', id, name: 'generate_linkedin_post', input: BRIEF },
    ],
  } as Anthropic.Message
}

function endTurn(text: string): Anthropic.Message {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] } as Anthropic.Message
}

function postText(n: number): string {
  return `Post #${n}: agents can now pay per call. #XRPL`
}

beforeEach(() => {
  replies = []
  payments = 0
  serviceStatus = 200
  modelCreate.mockReset()
  modelCreate.mockImplementation(async () => {
    const next = replies.shift()
    if (!next) throw new Error('unexpected model call')
    return next
  })
  payerFetch.mockReset()
  payerFetch.mockImplementation(async () => {
    payments++
    if (serviceStatus !== 200) {
      return Response.json({ ok: false, error: 'ANTHROPIC_FAILED' }, { status: serviceStatus })
    }
    const text = postText(payments)
    return Response.json({
      ok: true,
      post: { text, characterCount: text.length, hashtags: ['#XRPL'] },
      paid: { amountDrops: PRICE_DROPS.toString(), amountXrp: '0.4', currency: 'XRP' },
    })
  })
  vi.mocked(callPostService).mockClear()
})

function run(maxToolRounds?: number) {
  return runAgent({
    serverUrl: 'http://service.invalid',
    payer: {} as Wallet,
    network: 'testnet',
    anthropicApiKey: 'test-key',
    model: 'test-model',
    userRequest: 'Write a LinkedIn post about the SDK.',
    ...(maxToolRounds !== undefined && { maxToolRounds }),
  })
}

function counts() {
  return {
    modelCalls: modelCreate.mock.calls.length,
    toolExecutions: vi.mocked(callPostService).mock.calls.length,
    payments,
  }
}

describe('runAgent: a tool call on the last allowed round', () => {
  it('returns the paid result as the answer, with no extra model call', async () => {
    replies = [toolUse('tu_1', 'I will draft the post with the paid tool.')]

    const result = await run(1)

    expect(counts()).toEqual({ modelCalls: 1, toolExecutions: 1, payments: 1 })
    expect(result.rounds).toBe(1)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.totalDropsSpent).toBe(PRICE_DROPS)
    expect(result.finalText).toBe(postText(1))
  })

  it('returns the last round result, not an earlier one, at the default cap', async () => {
    replies = [toolUse('tu_1'), toolUse('tu_2'), toolUse('tu_3'), toolUse('tu_4')]

    const result = await run()

    expect(counts()).toEqual({ modelCalls: 4, toolExecutions: 4, payments: 4 })
    expect(result.rounds).toBe(4)
    expect(result.totalDropsSpent).toBe(4n * PRICE_DROPS)
    expect(result.finalText).toBe(postText(4))
  })

  it('reports a paid call that came back without a post', async () => {
    serviceStatus = 502
    replies = [toolUse('tu_1', 'Drafting now.')]

    const result = await run(1)

    expect(counts()).toEqual({ modelCalls: 1, toolExecutions: 1, payments: 1 })
    expect(result.toolCalls[0]?.result).toMatchObject({ ok: false, status: 502 })
    expect(result.finalText).toContain('HTTP 502')
    expect(result.finalText).not.toBe('Drafting now.')
  })
})

describe('runAgent: the normal path', () => {
  it('feeds the tool result back and returns the model answer', async () => {
    const answer = `\`\`\`\n${postText(1)}\n\`\`\`\nThe XRPL payment settled.`
    replies = [toolUse('tu_1', 'Drafting now.'), endTurn(answer)]

    const result = await run()

    expect(counts()).toEqual({ modelCalls: 2, toolExecutions: 1, payments: 1 })
    expect(result.rounds).toBe(2)
    expect(result.totalDropsSpent).toBe(PRICE_DROPS)
    expect(result.finalText).toBe(answer)
    const fedBack = JSON.stringify(modelCreate.mock.calls[1]?.[0].messages.at(-1))
    expect(fedBack).toContain('tu_1')
    expect(fedBack).toContain(postText(1))
  })

  it('answers without paying when the model calls no tool', async () => {
    replies = [endTurn('No post needed.')]

    const result = await run(1)

    expect(counts()).toEqual({ modelCalls: 1, toolExecutions: 0, payments: 0 })
    expect(result.rounds).toBe(1)
    expect(result.toolCalls).toEqual([])
    expect(result.finalText).toBe('No post needed.')
  })
})
