/**
 * Payment intent schema + pricing for the LinkedIn-post service.
 *
 * The "intent" is the JSON payload the agent's tool sends to
 * POST /linkedin-post before payment. The server validates it,
 * quotes a price, and only then issues the 402 challenge. Because
 * the price is bound to the challenge (which is itself signed by
 * mppx), the client cannot substitute a cheaper brief after the
 * challenge has been seen.
 */
import { z } from 'zod'

/**
 * Brief sent by the calling agent to the marketplace.
 *
 * Fields are intentionally narrow so a Claude agent can plug them in
 * directly via the tool-use API.
 */
export const PostBrief = z.object({
  company: z.string().min(1).max(120),
  product: z.string().min(1).max(120),
  audience: z.string().min(1).max(200),
  tone: z.enum(['professional', 'enthusiastic', 'technical', 'visionary']).default('professional'),
  keyPoints: z.array(z.string().min(1).max(280)).min(1).max(8),
  callToAction: z.string().min(1).max(280).optional(),
  /** Worst-case output token budget. Drives the 402 quote (see priceOf). */
  maxTokens: z.number().int().positive().min(64).max(4_000).default(400),
})

export type PostBrief = z.infer<typeof PostBrief>

/**
 * Quote the price (in drops) for a brief.
 *
 * Price = ceil( basePricePer1k * maxTokens / 1000 )
 *
 * Always rounds up so a tiny request still costs at least 1 drop. The
 * 1k-token unit is the same shape as Anthropic / OpenAI billing, so the
 * marketplace operator can re-price by tweaking a single constant.
 */
export function priceOf(brief: PostBrief, basePricePer1kDrops: bigint): bigint {
  const numerator = basePricePer1kDrops * BigInt(brief.maxTokens)
  const denominator = 1000n
  const price = (numerator + denominator - 1n) / denominator
  return price < 1n ? 1n : price
}
