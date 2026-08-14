/**
 * PayChannel -- Server-managed open (all-in-one demo)
 *
 * Demonstrates the `action: 'open'` MPP flow where the CLIENT signs the
 * PaymentChannelCreate tx but the SERVER submits it and extracts the
 * channelId from the resulting ledger metadata.
 *
 * Contrast with channel-client.ts, where the client calls openChannel()
 * and submits the tx itself before telling the server the channelId.
 *
 * Flow:
 *   1. Client calls prepareOpenChannelTransaction() -- signs but does NOT submit
 *   2. Client GETs /open -> server issues a 402 challenge
 *   3. Mppx retries with context { action: 'open', openTransaction: txBlob }
 *   4. Server submits the blob, waits for ledger confirmation, extracts channelId
 *   5. Client reads channelId from the receipt reference
 *   6. Client makes 3 paid voucher requests (zero on-chain cost)
 *   7. Client closes the channel on-chain with the final cumulative claim
 *
 * Run: npx tsx demo/channel-server-open.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store } from 'mppx/server'
import {
  channel as clientChannel,
  prepareOpenChannelTransaction,
} from '../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../sdk/src/channel/server/Channel.js'
import { bufferChallengeResponses } from '../sdk/src/client/fetch.js'
import { storeKeys } from '../sdk/src/utils/keys.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

const PORT = 3004
const NETWORK = 'testnet' as const

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
  log.box(['XRPL MPP Demo -- PayChannel (server-managed open)'])
  log.separator()

  // ── Phase 1: Fund wallets ─────────────────────────────────────────────────
  log.loading('Funding 2 wallets (server, client) via testnet faucet...')
  const [server, payer] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Server', server.address)
  log.wallet('Client', payer.address)
  log.key('Client public key', payer.publicKey)
  log.separator()

  // ── Phase 2: Client prepares (signs but does NOT submit) the open tx ──────
  log.loading('Client preparing PaymentChannelCreate tx (5 XRP, 3600s settle delay)...')
  const { txBlob, txHash: preparedHash } = await prepareOpenChannelTransaction({
    wallet: payer,
    destination: server.address,
    amount: '5000000', // 5 XRP in drops
    settleDelay: 3600,
    network: NETWORK,
  })
  log.success('Tx signed (not submitted)')
  log.key('Prepared tx hash', preparedHash)
  log.separator()

  // ── Phase 3: Server setup ─────────────────────────────────────────────────
  const store = Store.memory()

  // Server knows the client's publicKey upfront (shared out-of-band).
  // channelId is unknown until the open tx lands -- handlers are created dynamically.
  const channelMethod = serverChannel({ publicKey: payer.publicKey, network: NETWORK, store })
  const mppx = Mppx.create({ secretKey: demoSecretKey(), methods: [channelMethod] })

  // Open handler: amount '0' because the client makes no initial value claim
  // (the channelId placeholder sig carries no drops).
  const openHandler = mppx['xrpl/session']({
    amount: '0',
    channelId: '',
    recipient: server.address,
  })

  let channelId: string | null = null
  let voucherHandler: ReturnType<(typeof mppx)['xrpl/session']> | null = null
  let claimCount = 0
  let latestCumulative = '0'

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'

    try {
      // /open -- server-managed channel open
      if (path === '/open') {
        log.request(req.method ?? 'GET', path)
        const result = await openHandler(toWebRequest(req))

        if (result.status === 402) {
          log.challenge('Open challenge sent')
          log.response(402, 'challenge sent')
          await sendWebResponse(result.challenge as Response, res)
          return
        }

        // withReceipt() returns the Response with the Payment-Receipt header attached.
        // We read that header to extract channelId before forwarding the response.
        const openResponse = result.withReceipt(
          Response.json({ channelId, message: 'Channel opened by server' }),
        ) as Response

        // receipt.reference format: "open:{channelId}:{txHash}"
        const receiptHeader = openResponse.headers.get('Payment-Receipt')
        if (!receiptHeader) {
          res.statusCode = 500
          res.end('No Payment-Receipt header in open response')
          return
        }

        const receipt = Receipt.deserialize(receiptHeader)
        const parts = receipt.reference.split(':')
        channelId = parts[1] ?? null
        const openTxHash = parts[2] ?? ''

        if (!channelId) {
          res.statusCode = 500
          res.end('Could not extract channelId from receipt reference')
          return
        }

        log.success(`Channel opened on-chain by server: ${channelId}`)
        log.tx(openTxHash, log.explorerLink(openTxHash))

        // Now that we know the channelId, configure the voucher handler
        voucherHandler = mppx['xrpl/session']({
          amount: '100000', // 0.1 XRP per request
          channelId,
          recipient: server.address,
        })

        log.response(200, 'channel open confirmed')
        await sendWebResponse(openResponse, res)
        return
      }

      // /resource -- 402-gated resource, paid with off-chain vouchers
      if (path === '/resource') {
        if (!voucherHandler) {
          res.statusCode = 503
          res.end('Channel not open yet')
          return
        }

        log.request(req.method ?? 'GET', path)
        const result = await voucherHandler(toWebRequest(req))

        if (result.status === 402) {
          log.challenge('Payment required -- 100,000 drops (0.1 XRP)')
          log.response(402, 'challenge sent')
          await sendWebResponse(result.challenge as Response, res)
          return
        }

        claimCount++
        if (!channelId) {
          res.writeHead(503)
          res.end('Channel not open yet')
          return
        }
        const state = (await store.get(storeKeys(NETWORK).channel(channelId))) as any
        latestCumulative = state?.cumulative ?? latestCumulative

        log.verify(`Claim #${claimCount}`)
        log.success(`Verified -- cumulative: ${latestCumulative} drops`)
        log.response(200, 'access granted')

        await sendWebResponse(
          result.withReceipt(
            Response.json({
              message: `Access granted -- claim #${claimCount}`,
              content: 'Hello XRPL!',
              cumulative: latestCumulative,
            }),
          ) as Response,
          res,
        )
        return
      }

      res.statusCode = 404
      res.end('Not found')
    } catch (err: any) {
      log.error(err.message)
      res.statusCode = 500
      res.end(err.message)
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))
  log.server(`Server listening on http://localhost:${PORT}`)
  log.separator()

  // ── Phase 4: Client opens the channel via MPP ─────────────────────────────
  const clientMethod = clientChannel({ wallet: payer, network: NETWORK })
  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  ClientMppx.create({ methods: [clientMethod] })

  log.loading('Client opening channel via MPP (server will submit the tx)...')

  // Pass action: 'open' and the signed blob as context.
  // Mppx intercepts the 402 and passes context to createCredential().
  const openRes = await fetch(`http://localhost:${PORT}/open`, {
    context: { action: 'open', openTransaction: txBlob },
  } as any)

  if (!openRes.ok) {
    log.error(`Open failed: ${openRes.status} ${await openRes.text()}`)
    process.exit(1)
  }
  // Read channelId from the Payment-Receipt header -- the body's channelId field
  // is unreliable because the server serializes it before extracting the real value.
  const receiptHeader = openRes.headers.get('Payment-Receipt')
  if (!receiptHeader) {
    log.error('No Payment-Receipt header in open response')
    process.exit(1)
  }
  const openReceipt = Receipt.deserialize(receiptHeader)
  // receipt.reference format: "open:{channelId}:{txHash}"
  const realChannelId = openReceipt.reference.split(':')[1]
  log.success(`Client received channelId: ${realChannelId}`)
  log.info(`Open receipt reference: ${openReceipt.reference}`)
  log.separator()

  // ── Phase 5: Make 3 paid voucher requests ─────────────────────────────────
  log.info('Making 3 paid requests (0.1 XRP each, off-chain)...')
  log.separator()

  for (let i = 1; i <= 3; i++) {
    const response = await fetch(`http://localhost:${PORT}/resource`)
    if (response.ok) {
      const body = (await response.json()) as any
      log.success(`[${i}/3] "${body.content}" -- cumulative: ${body.cumulative} drops`)
    } else {
      log.error(`[${i}/3] ${response.status}`)
    }
  }

  log.separator()

  // ── Phase 6: Close the channel on-chain ───────────────────────────────────
  log.loading('Client closing channel on-chain...')
  const closeSig = payer.signChannelClaim(realChannelId, latestCumulative)
  const { txHash: closeHash } = await close({
    wallet: payer,
    channelId: realChannelId,
    amount: latestCumulative,
    signature: closeSig,
    channelPublicKey: payer.publicKey,
    network: NETWORK,
  })
  log.success('Channel closed')
  log.tx(closeHash, log.explorerLink(closeHash))

  httpServer.close()
  log.separator()
  log.box([
    'Summary',
    '',
    `Channel:          ${realChannelId}`,
    `Off-chain claims: 3`,
    `Total settled:    ${latestCumulative} drops (${(Number(latestCumulative) / 1_000_000).toFixed(1)} XRP)`,
    `On-chain txs:     2 (server-submitted open + client close)`,
    '',
    'Key difference vs channel-client.ts:',
    '  client signed the open tx, SERVER submitted it',
  ])
  log.separator()

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
