import type { Client } from 'xrpl'
import { verificationFailed } from '../errors.js'
import type { IssuedCurrency } from '../types.js'

/**
 * IOU Amount object as it appears on a Payment transaction.
 */
type IouAmount = { currency: string; issuer: string; value: string }

/**
 * Source amount returned by ripple_path_find -- either a drops string (XRP)
 * or an IOU amount object.
 */
type SourceAmount = string | IouAmount

/**
 * One path step in an XRPL path.
 *
 * The shape varies by step type (issuer hop, currency hop, account hop). We
 * pass these through to the Payment tx unchanged, so a partial type is enough.
 */
type PathStep = {
  account?: string
  currency?: string
  issuer?: string
  type?: number
  type_hex?: string
}

/**
 * Resolved extras to attach to a Payment transaction whose Amount is an IOU.
 *
 * - `Paths`: only set when path-finding ran (cross-issuer case). Direct-trustline
 *   and self-issued paths use no explicit Paths.
 * - `SendMax`: amount cap on the source side, including TransferRate and the
 *   slippage buffer. Skipped only when the sender is the issuer (no fee path).
 * - `sourceAmountValue` / `sourceAmountCurrency` / `sourceAmountIssuer`: the
 *   pre-slippage source amount, exposed for telemetry / progress events.
 */
type ResolvedIouExtras = {
  Paths?: PathStep[][]
  SendMax?: SourceAmount
  sourceAmountValue: string
  sourceAmountCurrency: string
  sourceAmountIssuer?: string
  /** Resolution path actually taken. */
  strategy: 'self-issued' | 'direct-trustline' | 'cross-issuer'
}

/**
 * Validate slippage is within the acceptable range. Throws an actionable error
 * with INVALID_AMOUNT for callers that pass a typo or wildly out-of-range value.
 */
export function validateSlippageBps(slippageBps: number): void {
  if (
    !Number.isFinite(slippageBps) ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 1000
  ) {
    throw new Error(
      `[INVALID_AMOUNT] slippageBps must be an integer between 0 and 1000 (max 10%), got ${slippageBps}.`,
    )
  }
}

/**
 * Resolve Paths + SendMax for an IOU payment. The caller (charge client) just
 * spreads the result onto the Payment tx before autofill.
 *
 * Decision order:
 * 1. Sender is the issuer (sender == Amount.issuer): no path, no SendMax.
 *    Self-issued IOU has no transfer fee and no market.
 * 2. Recipient holds a direct trustline with the same issuer as Amount: no
 *    Paths needed (default rippling on the issuer handles it). SendMax still
 *    applied to cover the issuer's TransferRate plus slippage.
 * 3. Cross-issuer: call ripple_path_find. Pick the cheapest alternative.
 *    SendMax = source_amount * (1 + slippage). Paths = chosen alternative.
 *    No alternatives -> PAYMENT_PATH_FAILED.
 */
export async function resolveIouPaymentExtras(params: {
  client: Client
  sender: string
  recipient: string
  destinationAmount: IouAmount
  slippageBps: number
  /**
   * Backoff delays (ms) between ripple_path_find retries when the first call
   * returns no alternatives or times out. Default `[1000, 2000, 4000]`. Pass
   * an empty array to disable retries (useful in tests where the mock returns
   * a definitive empty answer).
   */
  pathFindRetryDelaysMs?: number[]
}): Promise<ResolvedIouExtras> {
  const {
    client,
    sender,
    recipient,
    destinationAmount,
    slippageBps,
    pathFindRetryDelaysMs = [1_000, 2_000, 4_000],
  } = params

  // Case 1: sender == issuer (self-issued IOU). No path, no SendMax.
  if (sender === destinationAmount.issuer) {
    return {
      sourceAmountValue: destinationAmount.value,
      sourceAmountCurrency: destinationAmount.currency,
      sourceAmountIssuer: destinationAmount.issuer,
      strategy: 'self-issued',
    }
  }

  const transferRateFactor = await readTransferRateFactor(client, destinationAmount.issuer)

  // Case 2: direct trustline. The sender -> issuer -> recipient route via
  // rippling only works when both parties trust the same issuer for the same
  // currency. Asymmetric cases (only one side holds the issuer's trustline)
  // fall through to Case 3 because the orderbook is the only viable route.
  const [recipientHasDirectTrustline, senderHasDirectTrustline] = await Promise.all([
    accountHoldsTrustline(client, recipient, destinationAmount),
    accountHoldsTrustline(client, sender, destinationAmount),
  ])
  if (recipientHasDirectTrustline && senderHasDirectTrustline) {
    const sourceValue = multiplyDecimal(destinationAmount.value, transferRateFactor)
    const sendMaxValue = applySlippage(sourceValue, slippageBps)
    return {
      SendMax: {
        currency: destinationAmount.currency,
        issuer: destinationAmount.issuer,
        value: sendMaxValue,
      },
      sourceAmountValue: sourceValue,
      sourceAmountCurrency: destinationAmount.currency,
      sourceAmountIssuer: destinationAmount.issuer,
      strategy: 'direct-trustline',
    }
  }

  // Case 3: cross-issuer. Ask the ledger for paths.
  //
  // Pass the sender's holdings as `source_currencies` so the ledger only
  // returns alternatives the sender can actually afford. ripple_path_find is
  // non-blocking; the first call after a new offer can return zero
  // alternatives while the path indexer warms its cache, hence the retries.
  const sourceCurrencies = await listSourceCurrencies(client, sender)
  const alternatives = await pathFindWithRetry(
    client,
    {
      source_account: sender,
      destination_account: recipient,
      destination_amount: destinationAmount,
      ...(sourceCurrencies.length > 0 ? { source_currencies: sourceCurrencies } : {}),
    },
    pathFindRetryDelaysMs,
  )
  if (alternatives.length === 0) {
    throw verificationFailed(
      'PAYMENT_PATH_FAILED',
      `No path from ${sender} to ${recipient} for ${destinationAmount.value} ${destinationAmount.currency}.${destinationAmount.issuer}. ` +
        'The recipient may need a trustline that connects to the source liquidity, or there is no liquidity for this pair right now.',
    )
  }

  const chosen = pickCheapestAlternative(alternatives)
  const sendMax = applySlippageToSourceAmount(chosen.source_amount, slippageBps)
  const sourceMeta = describeSourceAmount(chosen.source_amount)

  return {
    Paths: chosen.paths_computed,
    SendMax: sendMax,
    sourceAmountValue: sourceMeta.value,
    sourceAmountCurrency: sourceMeta.currency,
    sourceAmountIssuer: sourceMeta.issuer,
    strategy: 'cross-issuer',
  }
}

// -- Ledger helpers ----------------------------------------------------------

/**
 * Run ripple_path_find with a few retries between calls so a cold path
 * indexer has time to warm. Total worst-case wait: ~7 seconds (1 + 2 + 4s
 * backoff over 3 attempts). Cheaper than letting tecPATH_DRY surface at
 * submit time.
 */
async function pathFindWithRetry(
  client: Client,
  request: {
    source_account: string
    destination_account: string
    destination_amount: IouAmount
    source_currencies?: Array<{ currency: string; issuer?: string }>
  },
  delaysMs: number[],
): Promise<Array<{ paths_computed: PathStep[][]; source_amount: SourceAmount }>> {
  let lastError: unknown
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      const delay = delaysMs[attempt - 1]
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }
    try {
      const res = (await client.request({ command: 'ripple_path_find', ...request } as any)) as any
      const alternatives =
        (res?.result?.alternatives as
          | Array<{ paths_computed: PathStep[][]; source_amount: SourceAmount }>
          | undefined) ?? []
      if (alternatives.length > 0) return alternatives
      lastError = undefined
    } catch (err) {
      lastError = err
    }
  }
  if (lastError) throw lastError
  return []
}

/**
 * Read the issuer's TransferRate as a decimal multiplier. Default 1 (no fee).
 *
 * On XRPL, TransferRate is stored as an integer in [1_000_000_000, 2_000_000_000]
 * where 1_000_000_000 = no fee. A value of 1_005_000_000 means "send 100.5 to
 * deliver 100" (0.5% fee).
 */
async function readTransferRateFactor(client: Client, issuer: string): Promise<number> {
  try {
    const r = await client.request({ command: 'account_info', account: issuer })
    const rate = (r.result.account_data as any).TransferRate as number | undefined
    if (rate === undefined || rate === 0) return 1
    return rate / 1_000_000_000
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return 1
    throw err
  }
}

/**
 * Return true when `account` holds a trustline for `currency.currency` issued
 * by `currency.issuer`. Defensive about the ledger response: matches both the
 * currency code and the peer (line.account) to defeat servers that don't
 * filter on `peer` and to cleanly compose with mocked clients in tests.
 */
async function accountHoldsTrustline(
  client: Client,
  account: string,
  currency: IssuedCurrency,
): Promise<boolean> {
  try {
    const r = await client.request({
      command: 'account_lines',
      account,
      peer: currency.issuer,
    })
    return (r.result.lines as any[]).some(
      (l) => l.currency === currency.currency && l.account === currency.issuer,
    )
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return false
    throw err
  }
}

/**
 * Build the `source_currencies` list for ripple_path_find. Includes every IOU
 * the sender holds (any non-empty trustline) plus XRP, since path finders may
 * route through XRP as a bridge currency.
 */
async function listSourceCurrencies(
  client: Client,
  sender: string,
): Promise<Array<{ currency: string; issuer?: string }>> {
  try {
    const r = await client.request({ command: 'account_lines', account: sender })
    const lines = r.result.lines as any[]
    const out: Array<{ currency: string; issuer?: string }> = [{ currency: 'XRP' }]
    for (const line of lines) {
      out.push({ currency: line.currency, issuer: line.account })
    }
    return out
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return [{ currency: 'XRP' }]
    throw err
  }
}

// -- Alternative ranking and amount math -------------------------------------

/**
 * Pick the cheapest alternative by source_amount. The sort key normalises
 * across currencies (XRP drops are converted to XRP units before comparing),
 * which is good enough for ranking since the SDK's SendMax math uses
 * string-decimal arithmetic on the chosen alternative.
 */
function pickCheapestAlternative<
  T extends { paths_computed: PathStep[][]; source_amount: SourceAmount },
>(alternatives: T[]): T {
  let best = alternatives[0]
  let bestKey = sourceAmountSortKey(best.source_amount)
  for (let i = 1; i < alternatives.length; i++) {
    const k = sourceAmountSortKey(alternatives[i].source_amount)
    if (k < bestKey) {
      best = alternatives[i]
      bestKey = k
    }
  }
  return best
}

function sourceAmountSortKey(amount: SourceAmount): number {
  if (typeof amount === 'string') return Number(amount) / 1_000_000
  return Number(amount.value)
}

/**
 * Apply the slippage buffer to a path-find source_amount, returning a value
 * suitable for the `SendMax` field of a Payment.
 */
function applySlippageToSourceAmount(source: SourceAmount, slippageBps: number): SourceAmount {
  if (typeof source === 'string') {
    const factor = 1 + slippageBps / 10_000
    const drops = BigInt(source)
    const buffered = (drops * BigInt(Math.round(factor * 1_000_000))) / 1_000_000n
    // Force at least +1 drop when slippage > 0 so a tiny source amount
    // doesn't truncate back to the original after the BigInt division.
    const min = slippageBps > 0 ? drops + 1n : drops
    return (buffered > min ? buffered : min).toString()
  }
  return {
    currency: source.currency,
    issuer: source.issuer ?? '',
    value: applySlippage(source.value, slippageBps),
  }
}

function describeSourceAmount(source: SourceAmount): {
  value: string
  currency: string
  issuer?: string
} {
  if (typeof source === 'string') return { value: source, currency: 'XRP' }
  return { value: source.value, currency: source.currency, issuer: source.issuer }
}

/**
 * Multiply a decimal IOU value string by a Number multiplier and return a
 * decimal string. Used for TransferRate adjustments. Operates in Number
 * (double precision) since IOU values fit in 16 significant digits and the
 * multipliers we use here (TransferRate * slippage) are bounded.
 */
function multiplyDecimal(value: string, multiplier: number): string {
  if (multiplier === 1) return value
  // Number is good for ~16 significant digits, which matches XRPL IOU
  // encoding (15-16 sig digs). Slippage and TransferRate multipliers are
  // bounded so compounding rounding stays well within the SendMax buffer.
  const product = Number(value) * multiplier
  return formatDecimal(product)
}

function applySlippage(value: string, slippageBps: number): string {
  if (slippageBps === 0) return value
  const factor = 1 + slippageBps / 10_000
  return multiplyDecimal(value, factor)
}

/**
 * Format a number as a decimal string with at most 16 significant digits and
 * no scientific notation. Used to keep IOU values in the canonical XRPL form.
 */
function formatDecimal(n: number): string {
  if (!Number.isFinite(n)) return n.toString()
  if (n === 0) return '0'
  const sig = n.toPrecision(16)
  if (!sig.includes('e') && !sig.includes('E')) {
    return trimTrailingZeros(sig)
  }
  // toPrecision returned scientific notation. Expand it to plain decimal so
  // the result is canonical for XRPL IOU values.
  const [mantissa, expPart] = sig.toLowerCase().split('e')
  const exp = Number.parseInt(expPart ?? '0', 10)
  const sign = mantissa.startsWith('-') ? '-' : ''
  const m = mantissa.replace(/^[-+]/, '')
  const [intPart, fracPart = ''] = m.split('.')
  const digits = intPart + fracPart
  const pointPos = intPart.length + exp
  let out: string
  if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length)
  } else if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  }
  return sign + trimTrailingZeros(out)
}

function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/\.?0+$/, '')
}
