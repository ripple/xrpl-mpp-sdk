/**
 * LLM Marketplace -- PayChannel mode + just-in-time fund -- Client
 *
 * Counterpart of channel-fund/server.ts. Same 3-prompt flow as channel/,
 * but the client opens the channel with a deliberately TINY initial
 * deposit (5 000 drops -- enough only for prompt 1) and tops up
 * reactively when the server replies 402 + CHANNEL_EXHAUSTED. Each
 * top-up is one PaymentChannelFund transaction.
 *
 * The win: peak locked capital stays close to the running cumulative
 * cost (~0.02 XRP for 3 prompts), instead of the worst-case lump sum
 * the eager variant pre-commits (5 XRP). Trade-off: more on-chain txs
 * (open + N funds + close vs open + close).
 *
 * Pricing: the client holds **no per-token price table**. The size of
 * every top-up is derived from the CHANNEL_EXHAUSTED 402's Problem
 * Details body -- which carries the cumulative voucher amount the
 * marketplace is asking for plus the on-chain deposit currently
 * available. The required top-up is exactly `cumulative - available`,
 * so the client never has to mirror the marketplace's rate table.
 *
 * Run: npx tsx demo/llm-marketplace/channel-fund/client.ts
 *      (after `npx tsx demo/llm-marketplace/channel-fund/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { unixTimeToRippleTime } from 'xrpl'
import {
  channel,
  fundChannel,
  prepareOpenChannelTransaction,
} from '../../../sdk/src/channel/client/Channel.js'
import { close } from '../../../sdk/src/channel/server/Channel.js'
import { bufferChallengeResponses } from '../../../sdk/src/client/fetch.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3006
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const
const rawFetch = globalThis.fetch

/**
 * Initial deposit, in drops. Picked to barely cover prompt 1's worst-case
 * quote (~3 210 drops). Prompts 2 and 3 will therefore each trigger a
 * CHANNEL_EXHAUSTED on first try, exercising the just-in-time fund path.
 */
const INITIAL_DEPOSIT_DROPS = '5000'
const SETTLE_DELAY_SECONDS = 3600
// Hard on-chain expiration. Defense-in-depth so the channel cannot leak
// forever if both the funder process AND the server's auto-close fail
// to fire. Once CancelAfter is reached, anyone can submit a
// PaymentChannelClaim that destroys the channel and refunds the unspent
// deposit to the funder.
const CANCEL_AFTER_SECONDS = 24 * 60 * 60

/** Bounds the retry loop so a misconfigured server can't loop the demo forever. */
const MAX_FUND_RETRIES_PER_PROMPT = 3

/**
 * Same 3 prompts as `channel/client.ts`, on purpose -- the lazy-fund
 * variant must produce identical Anthropic costs to make the comparison
 * with the eager variant meaningful.
 */
const PROMPTS: Array<{ prompt: string; maxTokens: number }> = [
  { prompt: 'Define the Machine Payments Protocol in one short sentence.', maxTokens: 60 },
  {
    prompt:
      'In bullet points, list 3 differences between MPP "charge" mode (one Payment per call) and MPP "channel" mode (PayChannel + off-chain vouchers).',
    maxTokens: 220,
  },
  {
    prompt:
      'Write a haiku about pay channels on the XRP Ledger, then a one-sentence explanation of the imagery.',
    maxTokens: 120,
  },
]

type DoneEvent = {
  call: number
  input_tokens: number
  output_tokens: number
  actual_cost: number
  paid: number
  overpayment: number
  voucher_cumulative: string
}

/**
 * Parse the Problem Details body of a CHANNEL_EXHAUSTED 402 to extract
 * the voucher cumulative the marketplace is asking for and the on-chain
 * deposit currently available. Returns null if the body is not in that
 * shape so the caller can degrade gracefully.
 *
 * Source format (from sdk/src/errors.ts `amountExceedsDeposit`):
 *   "[CHANNEL_EXHAUSTED] Cumulative {X} drops on channel {id}
 *    exceeds available balance {Y} drops -- top up via
 *    PaymentChannelFund or reset cumulative."
 *
 * mppx wraps it as the `detail` field of an RFC 9457 Problem Details JSON
 * body alongside `type: ".../amount-exceeds-deposit"`. The regex tolerates
 * either the JSON-escaped or the plain text form.
 */
function parseExhaustedQuote(bodyText: string): { cumulative: bigint; available: bigint } | null {
  const match = bodyText.match(
    /Cumulative\s+(\d+)\s+drops\s+on\s+channel\s+\S+\s+exceeds\s+available\s+balance\s+(\d+)\s+drops/,
  )
  if (!match) return null
  return { cumulative: BigInt(match[1]!), available: BigInt(match[2]!) }
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

/**
 * Run a single prompt, transparently topping up the channel via
 * PaymentChannelFund every time the server replies 409 + CHANNEL_EXHAUSTED.
 * Returns the final `done` event plus the list of fund tx hashes performed
 * for this prompt (almost always 0 or 1 in this demo).
 */
async function streamPromptWithLazyFund(args: {
  index: number
  total: number
  prompt: string
  maxTokens: number
  wallet: Wallet
  channelId: string
  /** In/out: current channel deposit, mutated as we top up. */
  depositRef: { current: bigint }
}): Promise<{ done: DoneEvent; fundTxs: string[]; topUpDrops: bigint }> {
  const { index, total, prompt, maxTokens, wallet, channelId, depositRef } = args

  log.separator()
  log.info(`[prompt ${index}/${total}] "${prompt}"`)
  log.info(
    `Current channel deposit: ${formatAmount(depositRef.current.toString(), 'XRP')}. ` +
      `Worst-case quote: not known -- will arrive in the 402 if a top-up is needed.`,
  )
  log.separator()

  const fundTxs: string[] = []
  let topUpDrops = 0n

  for (let attempt = 0; attempt <= MAX_FUND_RETRIES_PER_PROMPT; attempt++) {
    const response = await fetch(`${BASE}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
    })

    // mppx converts a thrown PaymentError from verify() into a 402 response
    // carrying an RFC 9457 Problem Details body. CHANNEL_EXHAUSTED surfaces
    // as `type: ".../amount-exceeds-deposit"` -- detect it and top up the
    // channel before retrying. Any other 402 reaching us means mppx already
    // tried the credential dance and the server still refused, so it's not
    // recoverable by us.
    if (response.status === 402) {
      const bodyText = await response.text().catch(() => '')
      const isExhausted =
        bodyText.includes('amount-exceeds-deposit') || bodyText.includes('CHANNEL_EXHAUSTED')
      if (!isExhausted) {
        log.error(`Unexpected 402 (not CHANNEL_EXHAUSTED): ${bodyText.slice(0, 200)}`)
        process.exit(1)
      }
      // The Problem Details body carries the cumulative voucher the
      // marketplace is asking for and the on-chain deposit currently
      // available. The exact top-up needed is the delta -- no client-side
      // pricing maths required. (We *only* learn the per-call rate by
      // reading what the marketplace just demanded.)
      const parsed = parseExhaustedQuote(bodyText)
      if (!parsed) {
        log.error(`Could not extract cumulative/available from 402 body: ${bodyText.slice(0, 200)}`)
        process.exit(1)
      }
      const topUp = parsed.cumulative - parsed.available
      if (topUp <= 0n) {
        log.error(
          `Refusing to PaymentChannelFund by ${topUp} drops -- ` +
            `cumulative=${parsed.cumulative} available=${parsed.available}.`,
        )
        process.exit(1)
      }
      log.fix(
        `Channel exhausted (mppx 402, amount-exceeds-deposit). ` +
          `Marketplace wants cumulative ${formatAmount(parsed.cumulative.toString(), 'XRP')}, ` +
          `deposit currently ${formatAmount(parsed.available.toString(), 'XRP')}. ` +
          `Submitting PaymentChannelFund(+${formatAmount(topUp.toString(), 'XRP')}) and retrying...`,
      )
      const { txHash } = await fundChannel({
        wallet,
        channelId,
        amount: topUp.toString(),
        network: NETWORK,
      })
      fundTxs.push(txHash)
      topUpDrops += topUp
      depositRef.current += topUp
      log.tx(txHash, log.explorerLink(txHash))
      log.success(
        `Channel deposit topped up. New deposit: ${formatAmount(depositRef.current.toString(), 'XRP')}.`,
      )
      continue
    }

    if (!response.ok || !response.body) {
      log.error(`Request failed: ${response.status} ${await response.text().catch(() => '')}`)
      process.exit(1)
    }

    try {
      const receipt = Receipt.fromResponse(response)
      log.success('Voucher accepted (off-chain claim, no tx)')
      log.info(`Receipt reference: ${receipt.reference}`)
    } catch {
      // No header -- continue without the receipt log.
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

    if (!done) {
      log.error('Stream ended without a done event')
      process.exit(1)
    }

    log.separator()
    // `done.paid` is the worst-case quote the marketplace announced in
    // the 402 for THIS call; the client never derived it.
    log.success(
      `Call #${done.call}: ${done.input_tokens}in + ${done.output_tokens}out -> ` +
        `real ${formatAmount(done.actual_cost, 'XRP')}, ` +
        `voucher +${formatAmount(done.paid, 'XRP')} (overpay ${formatAmount(done.overpayment, 'XRP')}), ` +
        `cumulative ${formatAmount(done.voucher_cumulative, 'XRP')}`,
    )
    return { done, fundTxs, topUpDrops }
  }

  log.error(`Gave up after ${MAX_FUND_RETRIES_PER_PROMPT} fund attempts on prompt ${index}.`)
  process.exit(1)
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (channel + just-in-time fund client)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer', wallet.address)
  log.key('Payer publicKey', wallet.publicKey)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = (await (await rawFetch(`${BASE}/info`)).json()) as {
    address: string
    model: string
    network: string
  }
  log.wallet('Marketplace', info.address)
  log.info(`Model: ${info.model}`)
  log.info('Per-call price: not advertised here -- will arrive in each /complete 402')
  log.separator()

  log.loading('POST /register -- sharing publicKey with marketplace...')
  const regRes = await rawFetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: wallet.publicKey }),
  })
  if (!regRes.ok) {
    log.error(`Register failed: ${regRes.status} ${await regRes.text()}`)
    process.exit(1)
  }
  log.success('Marketplace armed -- ready to open the channel via MPP')
  log.separator()

  // Tiny initial deposit. Just enough for prompt 1's worst-case quote;
  // prompts 2 and 3 will exhaust the channel and trigger top-ups below.
  log.loading(
    `Preparing PaymentChannelCreate (DELIBERATELY small: ${INITIAL_DEPOSIT_DROPS} drops, ${SETTLE_DELAY_SECONDS}s settle delay, ${CANCEL_AFTER_SECONDS / 3600}h CancelAfter)...`,
  )
  const cancelAfterRipple = unixTimeToRippleTime(Date.now() + CANCEL_AFTER_SECONDS * 1000)
  const { txBlob, txHash: preparedHash } = await prepareOpenChannelTransaction({
    wallet,
    destination: info.address,
    amount: INITIAL_DEPOSIT_DROPS,
    settleDelay: SETTLE_DELAY_SECONDS,
    cancelAfter: cancelAfterRipple,
    network: NETWORK,
  })
  log.success('Open tx signed (not submitted)')
  log.key('Prepared tx hash', preparedHash)
  log.separator()

  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  Mppx.create({ methods: [channel({ wallet, network: NETWORK })] })

  log.loading('GET /open -- mppx will ship the signed open blob to the server...')
  const openRes = await fetch(`${BASE}/open`, {
    context: { action: 'open', openTransaction: txBlob },
  } as any)

  if (!openRes.ok) {
    log.error(`Open failed: ${openRes.status} ${await openRes.text()}`)
    process.exit(1)
  }

  const openReceiptHeader = openRes.headers.get('Payment-Receipt')
  if (!openReceiptHeader) {
    log.error('No Payment-Receipt header in open response')
    process.exit(1)
  }
  const openReceipt = Receipt.deserialize(openReceiptHeader)
  const refParts = openReceipt.reference.split(':')
  const channelId = refParts[1]
  const openTxHash = refParts[2] ?? ''
  if (!channelId) {
    log.error(`Could not extract channelId from receipt: ${openReceipt.reference}`)
    process.exit(1)
  }
  log.success(`Channel opened: ${channelId}`)
  if (openTxHash) log.tx(openTxHash, log.explorerLink(openTxHash))
  log.separator()

  // ── Run the 3 prompts; top up the channel as needed ─────────────────────
  const dones: DoneEvent[] = []
  const allFundTxs: string[] = []
  const depositRef = { current: BigInt(INITIAL_DEPOSIT_DROPS) }
  let peakDeposit = depositRef.current
  for (let i = 0; i < PROMPTS.length; i++) {
    const { prompt, maxTokens } = PROMPTS[i]!
    const { done, fundTxs } = await streamPromptWithLazyFund({
      index: i + 1,
      total: PROMPTS.length,
      prompt,
      maxTokens,
      wallet,
      channelId,
      depositRef,
    })
    dones.push(done)
    allFundTxs.push(...fundTxs)
    if (depositRef.current > peakDeposit) peakDeposit = depositRef.current
  }

  log.separator()

  // ── Close on-chain with the latest cumulative voucher ───────────────────
  const finalCumulative = dones[dones.length - 1]?.voucher_cumulative ?? '0'
  log.loading(`Closing channel on-chain with cumulative ${finalCumulative} drops...`)
  const closeSig = wallet.signChannelClaim(channelId, finalCumulative)
  const { txHash: closeHash } = await close({
    wallet,
    channelId,
    amount: finalCumulative,
    signature: closeSig,
    channelPublicKey: wallet.publicKey,
    network: NETWORK,
  })
  log.success('Channel closed')
  log.tx(closeHash, log.explorerLink(closeHash))
  log.separator()

  // ── Settlement summary ──────────────────────────────────────────────────
  const totalActual = dones.reduce((acc, d) => acc + d.actual_cost, 0)
  const totalPaid = Number(finalCumulative)
  const overpayment = totalPaid - totalActual
  const overpayPct = totalPaid > 0 ? (overpayment / totalPaid) * 100 : 0
  const onchainTxs = 2 + allFundTxs.length // open + funds + close

  // Comparison with the eager (channel/) variant: there we deposit 5 XRP
  // up-front. Here we never lock more than `peakDeposit`.
  const eagerLockedDrops = 5_000_000n
  const peakReductionRatio = Number(eagerLockedDrops) / Number(peakDeposit)

  const perCall = dones.map(
    (d, i) =>
      `  #${i + 1}  ${String(d.input_tokens).padStart(3)}in + ${String(d.output_tokens).padStart(3)}out  ` +
      `real ${String(d.actual_cost).padStart(5)}  voucher +${String(d.paid).padStart(5)}  ` +
      `(overpay ${String(d.overpayment).padStart(5)})`,
  )

  log.box([
    'Settlement -- channel + just-in-time fund',
    '',
    `Channel:                 ${channelId}`,
    `Initial deposit:         ${formatAmount(INITIAL_DEPOSIT_DROPS, 'XRP')}`,
    `Top-ups:                 ${allFundTxs.length} × PaymentChannelFund`,
    `Peak channel deposit:    ${formatAmount(peakDeposit.toString(), 'XRP')}`,
    '',
    'Per-call breakdown (drops):',
    ...perCall,
    '',
    `Voucher cumulative (closed): ${formatAmount(totalPaid, 'XRP')}`,
    `Actual Anthropic cost:       ${formatAmount(totalActual, 'XRP')}`,
    `Overpayment:                 ${formatAmount(overpayment, 'XRP')} (${overpayPct.toFixed(1)}%)`,
    '',
    `On-chain txs: ${onchainTxs} (1 open + ${allFundTxs.length} fund + 1 close) for ${dones.length} prompts`,
    '',
    'vs eager channel/ variant:',
    `  Eager peak locked:  ${formatAmount(eagerLockedDrops.toString(), 'XRP')}`,
    `  Lazy peak locked:   ${formatAmount(peakDeposit.toString(), 'XRP')} (~${peakReductionRatio.toFixed(0)}x less capital tied up)`,
    `  Eager on-chain txs: 2 (open + close)`,
    `  Lazy on-chain txs:  ${onchainTxs} (more txs, but right-sized capital)`,
    '',
    'Price discovery: every per-call quote AND every fund delta came from a 402.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
