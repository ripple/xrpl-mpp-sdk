/**
 * LLM Marketplace -- PayChannel mode -- Client
 *
 * Counterpart of channel/server.ts. End-to-end flow:
 *   1. POST /register          -- share our channel publicKey
 *   2. GET  /open              -- mppx auto-handles the 402: signs a
 *                                 PaymentChannelCreate blob (5 XRP) and
 *                                 ships it inside the credential. The server
 *                                 submits, returns the channelId via the
 *                                 Payment-Receipt header.
 *   3. POST /complete (× 3)    -- for each prompt, mppx auto-handles the 402:
 *                                 reads cumulativeAmount from the challenge,
 *                                 signs a new voucher for `prev + worstQuote`,
 *                                 server verifies off-chain (no tx) and SSE-
 *                                 streams Anthropic tokens back live.
 *   4. close(...)              -- one on-chain PaymentChannelClaim tfClose
 *                                 with the latest voucher to redeem and
 *                                 finalise the channel.
 *
 * Net result: 3 LLM calls = 2 on-chain txs (open + close), regardless of N.
 *
 * Pricing: the client holds **no per-token price table**. Every call's
 * worst-case quote is announced in the 402 challenge for that /complete
 * request; the SSE `done` event echoes the same number back as `paid` so
 * the settlement summary can print it without consulting any local rate.
 * The channel funding amount (5 XRP) is the client's own risk budget,
 * not a marketplace price.
 *
 * Run: npx tsx demo/llm-marketplace/channel/client.ts
 *      (after `npx tsx demo/llm-marketplace/channel/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { unixTimeToRippleTime } from 'xrpl'
import { channel, prepareOpenChannelTransaction } from '../../../sdk/src/channel/client/Channel.js'
import { close } from '../../../sdk/src/channel/server/Channel.js'
import { bufferChallengeResponses } from '../../../sdk/src/client/fetch.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'
import { formatAmount } from '../shared/format.js'

const PORT = 3005
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const
const rawFetch = globalThis.fetch

// 5 XRP is plenty for 3 small Haiku 4.5 prompts. The unused remainder
// is refunded on-chain at close.
const CHANNEL_AMOUNT_DROPS = '5000000'
const SETTLE_DELAY_SECONDS = 3600
// Hard on-chain expiration. Defense-in-depth so the channel cannot leak
// forever if both the funder process AND the server's auto-close fail
// to fire (e.g. both crash without persisting the latest voucher). Once
// CancelAfter is reached, anyone can submit a PaymentChannelClaim that
// destroys the channel and refunds the unspent deposit to the funder.
const CANCEL_AFTER_SECONDS = 24 * 60 * 60

/**
 * Three prompts of intentionally varied shape:
 *   - short Q&A (cheap, mostly input cost)
 *   - structured comparison (medium output)
 *   - creative writing (most output tokens)
 * Drives a visibly growing voucher cumulative across the 3 calls.
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

async function streamPrompt(
  index: number,
  total: number,
  prompt: string,
  maxTokens: number,
): Promise<DoneEvent> {
  log.separator()
  log.info(`[prompt ${index}/${total}] "${prompt}"`)
  log.info(`maxTokens: ${maxTokens} -- mppx will auto-handle the 402 with a fresh voucher`)
  log.separator()

  const response = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, maxTokens }),
  })

  if (!response.ok || !response.body) {
    log.error(`Request failed: ${response.status} ${await response.text().catch(() => '')}`)
    process.exit(1)
  }

  // Receipt.fromResponse may throw if the server didn't attach the header --
  // the channel verify path always does, but we degrade gracefully.
  try {
    const receipt = Receipt.fromResponse(response)
    log.success('Voucher accepted (off-chain claim, no tx)')
    log.info(`Receipt reference: ${receipt.reference}`)
  } catch {
    // No header -- continue without the cumulative log line.
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
  // `done.paid` is the worst-case quote the marketplace announced in the
  // 402 for THIS call -- the client did not derive it, just paid it.
  log.success(
    `Call #${done.call}: ${done.input_tokens}in + ${done.output_tokens}out -> ` +
      `real ${formatAmount(done.actual_cost, 'XRP')}, ` +
      `voucher +${formatAmount(done.paid, 'XRP')} (overpay ${formatAmount(done.overpayment, 'XRP')}), ` +
      `cumulative ${formatAmount(done.voucher_cumulative, 'XRP')}`,
  )
  return done
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (channel-mode client, 3 prompts)'])
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

  // Tell the server which key to verify claim signatures against. Without
  // this, the server cannot construct its xrpl/channel verifier and /open
  // returns 503.
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

  // Pre-sign the PaymentChannelCreate blob locally. The server will be the
  // one that submits it -- this is the "server-managed open" pattern.
  log.loading(
    `Preparing PaymentChannelCreate (${(Number(CHANNEL_AMOUNT_DROPS) / 1_000_000).toFixed(1)} XRP, ${SETTLE_DELAY_SECONDS}s settle delay, ${CANCEL_AFTER_SECONDS / 3600}h CancelAfter)...`,
  )
  const cancelAfterRipple = unixTimeToRippleTime(Date.now() + CANCEL_AFTER_SECONDS * 1000)
  const { txBlob, txHash: preparedHash } = await prepareOpenChannelTransaction({
    wallet,
    destination: info.address,
    amount: CHANNEL_AMOUNT_DROPS,
    settleDelay: SETTLE_DELAY_SECONDS,
    cancelAfter: cancelAfterRipple,
    network: NETWORK,
  })
  log.success('Open tx signed (not submitted)')
  log.key('Prepared tx hash', preparedHash)
  log.separator()

  // Patch fetch so all subsequent /complete calls auto-handle the 402.
  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  Mppx.create({ methods: [channel({ wallet, network: NETWORK })] })

  // Open the channel via MPP. mppx detects the 402 on /open, sees the
  // 'xrpl/channel' method, and forwards our context (action: 'open',
  // openTransaction: txBlob) into createCredential -- the server then
  // submits the blob and returns the real channelId in the Payment-Receipt.
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
  // receipt.reference format: "open:{channelId}:{txHash}"
  const refParts = openReceipt.reference.split(':')
  const channelId = refParts[1]
  const openTxHash = refParts[2] ?? ''
  if (!channelId) {
    log.error(`Could not extract channelId from receipt: ${openReceipt}`)
    process.exit(1)
  }
  log.success(`Channel opened: ${channelId}`)
  if (openTxHash) log.tx(openTxHash, log.explorerLink(openTxHash))
  log.separator()

  // ── Run the 3 prompts sequentially ──────────────────────────────────────
  const dones: DoneEvent[] = []
  for (let i = 0; i < PROMPTS.length; i++) {
    const { prompt, maxTokens } = PROMPTS[i]!
    const done = await streamPrompt(i + 1, PROMPTS.length, prompt, maxTokens)
    dones.push(done)
  }

  log.separator()

  // ── Close the channel with the latest cumulative voucher ────────────────
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

  const perCall = dones.map(
    (d, i) =>
      `  #${i + 1}  ${String(d.input_tokens).padStart(3)}in + ${String(d.output_tokens).padStart(3)}out  ` +
      `real ${String(d.actual_cost).padStart(5)}  voucher +${String(d.paid).padStart(5)}  ` +
      `(overpay ${String(d.overpayment).padStart(5)})`,
  )

  log.box([
    'Settlement -- channel mode',
    '',
    `Channel:           ${channelId}`,
    `Prompts settled:   ${dones.length}`,
    '',
    'Per-call breakdown (drops):',
    ...perCall,
    '',
    `Voucher cumulative (closed): ${formatAmount(totalPaid, 'XRP')}`,
    `Actual Anthropic cost:       ${formatAmount(totalActual, 'XRP')}`,
    `Overpayment:                 ${formatAmount(overpayment, 'XRP')} (${overpayPct.toFixed(1)}%)`,
    '',
    `On-chain txs: 2 (open + close) for ${dones.length} prompts`,
    `Same workload in charge mode would have cost ${dones.length} on-chain Payment txs.`,
    'Price discovery: every per-call quote came from the 402 challenge.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
