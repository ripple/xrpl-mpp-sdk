/**
 * Minimal XRPL MPP charge server.
 *
 * Usage:
 *   XRPL_RECIPIENT=rYourAddress npx tsx examples/server.ts
 *
 * Then test with:
 *   XRPL_SEED=sEdYourSeed npx tsx examples/client.ts
 *
 * Store selection below shows the production shape first, because this file
 * gets copied. `Store.memory()` is process-local: it is fine for this example
 * and for a single instance, and unsafe the moment a second replica exists,
 * since a payment accepted by one is unknown to the other and the paid resource
 * is delivered twice.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../sdk/src/server/Charge.js'
import { assertCredentialHeaderSize } from '../sdk/src/utils/limits.js'

const PORT = Number(process.env.PORT ?? 3000)
const RECIPIENT = process.env.XRPL_RECIPIENT

if (!RECIPIENT) {
  console.error('Usage: XRPL_RECIPIENT=rYourAddress npx tsx examples/server.ts')
  process.exit(1)
}

/**
 * Production wants a shared, durable store with atomic conditional writes:
 *
 *   import { Pool } from 'pg'
 *   import { sqlStore, sqlSchema } from '../sdk/src/server/index.js'
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 *   await pool.query(sqlSchema())
 *   const store = Store.from(sqlStore((sql, p) => pool.query(sql, [...p])))
 *   // ... and storeDurability: 'shared'
 *
 * Set DATABASE_URL to take that path. Without it this falls back to an
 * in-process store, which the SDK refuses outright on mainnet.
 */
const usingDurableStore = Boolean(process.env.DATABASE_URL)
if (!usingDurableStore) {
  console.warn('No DATABASE_URL: using a process-local store. Single instance only.')
}

// mppx requires at least 32 bytes, and every instance serving this realm must
// use the same value: the challenge id is an HMAC over it, so a per-instance
// secret makes a challenge issued by one instance unverifiable by the next.
const secretKey = process.env.MPP_SECRET_KEY
if (!secretKey) {
  throw new Error('MPP_SECRET_KEY is required. Generate one with `openssl rand -base64 32`.')
}

const mppx = Mppx.create({
  secretKey,
  methods: [
    charge({
      // The recipient is server configuration, never read from a request. A
      // caller who could choose it would redirect payment to themselves.
      recipient: RECIPIENT,
      network: 'testnet',
      store: Store.memory(),
      storeDurability: 'process-local',
    }),
  ],
})

// -- Node http <-> Web Request/Response bridge --

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

// -- Handler --

// Amount, currency and recipient are set here, server-side, and travel inside
// the HMAC-signed challenge. Verification reads them back from that challenge
// rather than from the credential the client sends, so a client cannot restate
// the price or redirect the payment: tampering changes the challenge id and the
// credential is rejected as not issued by this server.
const handler = mppx['xrpl/charge']({
  recipient: RECIPIENT,
  amount: '1000000', // 1 XRP
  currency: 'XRP',
  description: 'API access',
})

const server = createServer(async (req, res) => {
  // Before anything parses the credential. By the time verify() runs, mppx has
  // already decoded and parsed the header, so a size check there is too late to
  // avoid the work.
  try {
    assertCredentialHeaderSize(req.headers.authorization)
  } catch {
    res.writeHead(431)
    res.end()
    return
  }

  const result = await handler(toWebRequest(req))

  if (result.status === 402) {
    return sendWebResponse(result.challenge, res)
  }

  return sendWebResponse(
    result.withReceipt(
      Response.json({
        message: 'Payment verified -- here is your content.',
        timestamp: new Date().toISOString(),
      }),
    ),
    res,
  )
})

server.listen(PORT, () => {
  console.log(`XRPL MPP server on http://localhost:${PORT}`)
  console.log(`Recipient: ${RECIPIENT}`)
})
