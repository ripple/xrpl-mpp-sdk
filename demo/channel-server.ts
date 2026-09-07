/**
 * PayChannel -- Server
 * Generates a recipient wallet and serves a 402-gated resource over a channel.
 * Run: npx tsx demo/channel-server.ts
 *
 * Note what the payment path needs from the client, which is nothing. The
 * method is built once at startup with no funder key and no channel id: a
 * server cannot know either before a client opens a channel, and it does not
 * have to. Claims verify against the key the channel names on the ledger, and
 * each credential names its own channel.
 *
 * `POST /setup` survives only so this demo can print the cumulative and close
 * at the end. Take it out and the paid requests still work.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { channel } from '../sdk/src/channel/server/Channel.js'
import { storeKeys } from '../sdk/src/utils/keys.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost:3000'
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
  log.box(['XRPL MPP Server -- PayChannel'])
  log.separator()

  log.loading('Funding recipient wallet via faucet...')
  const wallet = await Wallet.fromFaucet({ network: 'testnet' })

  log.wallet('Recipient', wallet.address)
  log.separator()

  let channelId: string | null = null
  let claimCount = 0
  let latestCumulative = '0'
  const store = Store.memory()

  // No publicKey: every channel is verified against its own on-ledger key.
  // channelId '': the challenge pins no channel, so each credential names the
  // one it pays through. Both are what an open service wants.
  const channelMethod = channel({
    recipient: wallet.address,
    network: 'testnet',
    store,
    storeDurability: 'process-local',
  })
  const mppx = Mppx.create({ secretKey: demoSecretKey(), methods: [channelMethod] })
  const handler = mppx['xrpl/session']({
    amount: '100000',
    channelId: '',
    recipient: wallet.address,
  })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: wallet.address }))
        return
      }

      if (method === 'POST' && path === '/setup') {
        const body = JSON.parse(await readBody(req))
        channelId = body.channelId
        if (!channelId) {
          res.writeHead(400)
          res.end('channelId required')
          return
        }

        // Recorded for the closing claim and the cumulative readout below,
        // not for verification: the method above already accepts this channel.
        log.success(`Channel recorded for close: ${channelId}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }

      if (method === 'GET' && path === '/resource') {
        log.request('GET', '/resource')
        const result = await handler(toWebRequest(req))

        if (result.status === 402) {
          log.challenge('Payment required -- 100,000 drops (0.1 XRP)')
          log.response(402, 'challenge sent')
          await sendWebResponse(result.challenge as Response, res)
          return
        }

        claimCount++
        if (!channelId) {
          res.writeHead(503)
          res.end('Channel not configured yet')
          return
        }
        const state = (await store.get(storeKeys('testnet').channel(channelId))) as any
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

      if (method === 'GET' && path === '/summary') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ claimCount, cumulative: latestCumulative }))
        setTimeout(() => {
          log.separator()
          log.info(
            `Summary: ${claimCount} claims, ${(Number(latestCumulative) / 1_000_000).toFixed(1)} XRP total`,
          )
          httpServer.close()
          process.exit(0)
        }, 500)
        return
      }

      res.writeHead(404)
      res.end('Not found')
    } catch (err: any) {
      log.error(err.message)
      res.writeHead(500)
      res.end(err.message)
    }
  })

  httpServer.listen(3000, () => {
    log.separator()
    log.box([
      'Endpoints:',
      '',
      'GET  /info      ->  server wallet address',
      'POST /setup     ->  record channelId, for the closing claim only',
      'GET  /resource  ->  charge 0.1 XRP per claim',
      'GET  /summary   ->  final state + shutdown',
      '',
      'Waiting for client to open channel...',
    ])
    log.separator()
    log.server('Listening on http://localhost:3000')
  })
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
