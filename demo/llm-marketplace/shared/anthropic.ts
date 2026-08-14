/**
 * Shared helpers for the LLM marketplace demos.
 *
 * - Loads .env from `demo/llm-marketplace/.env` regardless of CWD
 * - Exposes a configured Anthropic client + the model id
 * - Centralises pricing (drops per input/output token) and the worst-case quote
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

const HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(HERE, '..', '.env') })

/** Anthropic model identifier. Override via ANTHROPIC_MODEL env var. */
export const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5'

/**
 * Demo "marketplace" pricing, in XRPL drops.
 *
 * Claude Haiku 4.5 real cost is $1/MTok input, $5/MTok output (1:5 ratio).
 * For terminal visibility we scale both up to integer drop counts while
 * preserving the 1:5 ratio. With these constants a typical 60-output-token
 * answer settles at ~3 000 drops (0.003 XRP), trivial on testnet.
 */
export const DROPS_PER_INPUT_TOKEN = 10
export const DROPS_PER_OUTPUT_TOKEN = 50

/**
 * Estimate input tokens from a prompt string (fallback before any API call).
 * ~3.5 chars/token is a reasonable English heuristic, plus a 20% buffer so
 * the 402 quote almost never under-charges.
 */
export function estimateInputTokens(prompt: string): number {
  return Math.ceil((prompt.length / 3.5) * 1.2)
}

/** Worst-case quote in drops, used as the 402 challenge amount. */
export function quoteDrops(inputEstimate: number, maxOutputTokens: number): number {
  return inputEstimate * DROPS_PER_INPUT_TOKEN + maxOutputTokens * DROPS_PER_OUTPUT_TOKEN
}

/** Actual cost in drops once Anthropic has returned its usage report. */
export function actualCostDrops(inputTokens: number, outputTokens: number): number {
  return inputTokens * DROPS_PER_INPUT_TOKEN + outputTokens * DROPS_PER_OUTPUT_TOKEN
}

/** Lazy-create an Anthropic client. Throws a friendly error if the key is missing. */
export function createAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey.startsWith('sk-ant-api03-...')) {
    throw new Error(
      '[llm-marketplace] ANTHROPIC_API_KEY missing. ' +
        'Copy demo/llm-marketplace/.env.example to .env and paste your key from ' +
        'https://console.anthropic.com (free $5 credit on signup).',
    )
  }
  return new Anthropic({ apiKey })
}
