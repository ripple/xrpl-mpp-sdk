/**
 * Minimal XRPL MPP channel server.
 *
 * Usage:
 *   XRPL_CHANNEL_RECIPIENT=rxxx XRPL_CHANNEL_PUBKEY=EDxxx \
 *     npx tsx examples/channel-server.ts
 *
 * The client opens the channel and POSTs { channelId } to /setup.
 * Then GET /resource is 402-gated via off-chain PayChannel claims.
 *
 * Note which values come from where. `recipient` is the address this server
 * expects the channel to pay, and it is read from the environment, never from
 * the request. Taking it from the client would defeat the point: a caller could
 * open a channel to their own address, pass that address, and every check would
 * agree while the claims stayed unredeemable by this server.
 *
 * Test with:
 *   npx tsx examples/channel-client.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { channel } from '../sdk/src/channel/server/Channel.js'

const PORT = Number(process.env.PORT ?? 3001)
const PUBKEY = process.env.XRPL_CHANNEL_PUBKEY
// Server-side configuration: the address the channel must pay. Never accepted
// from a request body.
const RECIPIENT = process.env.XRPL_CHANNEL_RECIPIENT

if (!PUBKEY || !RECIPIENT) {
  console.error(
    'Usage: XRPL_CHANNEL_RECIPIENT=rxxx XRPL_CHANNEL_PUBKEY=EDxxx ' +
      'npx tsx examples/channel-server.ts',
  )
  process.exit(1)
}

const store = Store.memory()
let handler: any = null

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c.toString()
    })
    req.on('end', () => resolve(body))
  })
}

function toWebRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  }
  return new Request(url, { method: req.method, headers })
}

async function sendWebResponse(webRes: Response, res: ServerResponse) {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

// mppx requires at least 32 bytes, and every instance serving this realm must
// use the same value: the challenge id is an HMAC over it, so a per-instance
// secret makes a challenge issued by one instance unverifiable by the next.
const secretKey = process.env.MPP_SECRET_KEY
if (!secretKey) {
  throw new Error('MPP_SECRET_KEY is required. Generate one with `openssl rand -base64 32`.')
}

const server = createServer(async (req, res) => {
  const path = req.url ?? '/'
  // POST /setup -- client sends { channelId } after opening the channel.
  // Only the channelId is taken from the request; the recipient is ours.
  if (req.method === 'POST' && path === '/setup') {
    const { channelId } = JSON.parse(await readBody(req))
    const mppx = Mppx.create({
      secretKey,
      methods: [
        channel({
          publicKey: PUBKEY,
          recipient: RECIPIENT,
          network: 'testnet',
          store,
          storeDurability: 'process-local',
        }),
      ],
    })
    handler = mppx['xrpl/session']({
      amount: '100000', // 0.1 XRP per request
      channelId,
      recipient: RECIPIENT,
    })
    console.log(`Channel configured: ${channelId}`)
    res.writeHead(200)
    res.end('ok')
    return
  }

  // GET /resource -- 402 / 200
  if (path === '/resource') {
    if (!handler) {
      res.writeHead(503)
      res.end('Channel not set up')
      return
    }
    const result = await handler(toWebRequest(req))
    if (result.status === 402) return sendWebResponse(result.challenge, res)
    return sendWebResponse(
      result.withReceipt(
        Response.json({ message: 'Paid content', timestamp: new Date().toISOString() }),
      ),
      res,
    )
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`XRPL MPP channel server on http://localhost:${PORT}`)
  console.log(`Waiting for POST /setup with { channelId, recipient }...`)
})
