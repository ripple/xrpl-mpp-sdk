/**
 * PayChannel fund / exhaustion / recovery -- All-in-one demo
 *
 * Demonstrates the full top-up lifecycle on a PayChannel:
 *
 *   1. Client opens a tiny 200,000-drop channel (0.2 XRP).
 *   2. Client makes 4 paid requests at 50,000 drops each. Cumulatives
 *      are 50k, 100k, 150k, 200k -- the last one matches the deposit
 *      exactly and is still accepted (cumulative <= deposit is the
 *      ledger invariant, not strict <).
 *   3. Client tries to claim 250,000 drops -- the SDK detects the
 *      cumulative now exceeds the on-chain deposit and surfaces a
 *      typed `CHANNEL_EXHAUSTED` instead of letting the close-time
 *      `tecAMM_BALANCE` / `tecOVERSIZE` cascade.
 *   4. Funder calls `wallet.fundChannel(...)` -- a `PaymentChannelFund`
 *      transaction adding 500,000 drops to the channel deposit. No
 *      new channel is opened, the channelId / signing key stay the
 *      same; the cumulative tracking on the server side is preserved.
 *   5. Client retries the previously-rejected claim. The server's
 *      metadata cache is auto-refreshed when the cumulative exceeds
 *      the cached deposit, so the top-up is detected without any
 *      manual cache busting.
 *   6. Client makes one more paid request to confirm the recovery,
 *      then closes the channel on-chain.
 *
 * Run-time: ~30 s on testnet.
 *
 * Run: npx tsx demo/channel-fund.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store } from 'mppx/server'
import {
  channel as clientChannel,
  fundChannel,
  openChannel,
} from '../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../sdk/src/channel/server/Channel.js'
import { bufferChallengeResponses } from '../sdk/src/client/fetch.js'
import { storeKeys } from '../sdk/src/utils/keys.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

const PORT = 3006
const NETWORK = 'testnet' as const

/** Initial channel deposit, in drops. Picked small so the exhaustion check fires after a handful of claims. */
const INITIAL_DEPOSIT = '200000'
/** Per-request increment, in drops. */
const PER_CLAIM = '50000'
/** Top-up amount when the channel exhausts, in drops. */
const TOPUP = '500000'

const rawFetch = globalThis.fetch

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `localhost:${PORT}`
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) {
      for (const val of v) headers.append(k, val)
    } else {
      headers.set(k, v)
    }
  }
  return new Request(url, { method: req.method ?? 'GET', headers })
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

async function main() {
  log.box(['XRPL MPP Demo -- PayChannel fund / exhaustion / recovery'])
  log.separator()

  log.loading('Funding 2 wallets via the testnet faucet (funder + recipient)...')
  const [funder, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Funder    ', funder.address)
  log.wallet('Recipient ', recipient.address)
  log.separator()

  // ── Step 1 -- open a deliberately-small channel ───────────────────
  log.loading(`Opening PaymentChannel deposit=${INITIAL_DEPOSIT} drops, settleDelay=3600s...`)
  const { channelId, txHash: openHash } = await openChannel({
    wallet: funder,
    destination: recipient.address,
    amount: INITIAL_DEPOSIT,
    settleDelay: 3600,
    network: NETWORK,
  })
  log.success(`Channel opened: ${channelId}`)
  log.tx(openHash, log.explorerLink(openHash))
  log.separator()

  // ── Server side: configure verify with a shared store ────────────
  const store = Store.memory()
  const channelMethod = serverChannel({
    publicKey: funder.publicKey,
    recipient: recipient.address,
    network: NETWORK,
    store,
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
  })
  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [channelMethod],
  })
  const handler = mppx['xrpl/session']({
    amount: PER_CLAIM,
    channelId,
    recipient: recipient.address,
  })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path !== '/resource') {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    log.request(req.method ?? 'GET', path)
    try {
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge(`Payment required -- ${PER_CLAIM} drops`)
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      const state = (await store.get(storeKeys(NETWORK).channel(channelId))) as {
        cumulative?: string
      } | null
      log.success(`Claim verified -- cumulative now ${state?.cumulative ?? '?'} drops`)
      log.response(200, 'access granted')
      await sendWebResponse(
        result.withReceipt(
          Response.json({
            cumulative: state?.cumulative ?? null,
          }),
        ) as Response,
        res,
      )
    } catch (err) {
      const message = (err as Error).message
      log.error(message.slice(0, 200))
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))
  log.server(`Server listening on http://localhost:${PORT}`)

  // ── Client side: register the auto-fetch interceptor ─────────────
  const cliMethod = clientChannel({ wallet: funder, network: NETWORK })
  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  ClientMppx.create({ methods: [cliMethod] })

  // ── Step 2 -- 4 successful claims (cumulatives 50k..200k) ────────
  log.separator()
  log.info('Phase 1 -- 4 paid requests, cumulative grows from 50k to 200k drops...')
  log.separator()
  for (let i = 1; i <= 4; i++) {
    const response = await fetch(`http://localhost:${PORT}/resource`)
    if (!response.ok) {
      log.error(`Request ${i}/4 unexpectedly failed: ${response.status}`)
      throw new Error('phase 1 sanity check failed')
    }
    const body = (await response.json()) as { cumulative: string | null }
    log.success(`[${i}/4] cumulative = ${body.cumulative} drops`)
  }
  log.separator()

  // ── Step 3 -- 5th claim must exhaust the channel ─────────────────
  log.info('Phase 2 -- 5th claim cumulative would be 250k > deposit 200k.')
  log.loading('Expecting CHANNEL_EXHAUSTED (cumulative > on-chain deposit)...')
  {
    const response = await fetch(`http://localhost:${PORT}/resource`)
    if (response.ok) {
      log.error('Server unexpectedly accepted a claim that exceeds the deposit.')
      throw new Error('phase 2 sanity check failed')
    }
    const body = await response.text()
    log.error(body.slice(0, 240))
    log.fix('Funder must call PaymentChannelFund to top up the deposit.')
  }
  log.separator()

  // ── Step 4 -- top up via PaymentChannelFund ──────────────────────
  log.loading(`Calling fundChannel(+${TOPUP} drops)...`)
  const { txHash: fundHash } = await fundChannel({
    wallet: funder,
    channelId,
    amount: TOPUP,
    network: NETWORK,
  })
  log.success('Channel topped up on-chain')
  log.tx(fundHash, log.explorerLink(fundHash))
  log.separator()

  // ── Step 5 -- retry the 5th claim now that deposit covers it ────
  log.info('Phase 3 -- retry the previously-exhausted claim, then add one more.')
  log.separator()
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://localhost:${PORT}/resource`)
    if (!response.ok) {
      const errBody = await response.text()
      log.error(`Request unexpectedly failed: ${errBody.slice(0, 200)}`)
      throw new Error('phase 3 sanity check failed')
    }
    const body = (await response.json()) as { cumulative: string | null }
    log.success(`Recovered claim -- cumulative = ${body.cumulative} drops`)
  }
  log.separator()

  // ── Step 6 -- close on-chain with the latest cumulative ──────────
  const finalState = (await store.get(storeKeys(NETWORK).channel(channelId))) as {
    cumulative: string
    signature: string
  } | null
  if (!finalState) {
    throw new Error('store is missing the latest cumulative -- cannot close cleanly')
  }
  log.loading(`Closing channel on-chain at cumulative=${finalState.cumulative} drops...`)
  const { txHash: closeHash } = await close({
    wallet: recipient,
    channelId,
    amount: finalState.cumulative,
    signature: finalState.signature,
    channelPublicKey: funder.publicKey,
    network: NETWORK,
    store,
  })
  log.success('Channel closed')
  log.tx(closeHash, log.explorerLink(closeHash))
  log.separator()

  log.box([
    'Summary',
    '',
    `Channel:           ${channelId}`,
    `Initial deposit:   ${INITIAL_DEPOSIT} drops (0.2 XRP)`,
    `Top-up:            +${TOPUP} drops (0.5 XRP)`,
    `Final cumulative:  ${finalState.cumulative} drops`,
    `On-chain txs:      3 (open + fund + close)`,
    `Off-chain claims:  6 (5 distinct vouchers, 1 retried after fund)`,
  ])

  httpServer.close()
  log.separator()
  log.info('PayChannel fund/exhaustion/recovery demo complete.')
  // The server kept rawFetch alive via the mppx interceptor; release it so
  // the process can exit.
  globalThis.fetch = rawFetch
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`)
  process.exit(1)
})
