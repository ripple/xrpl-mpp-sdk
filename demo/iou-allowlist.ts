/**
 * IOU allowlist (RequireAuth) -- All-in-one demo
 *
 * Mirror of `mpt-charge.ts` for the IOU code path. Walks the
 * issuer-controlled allowlist flow end-to-end:
 *
 *   1. Issuer enables `DefaultRipple` AND `RequireAuth` (must be set
 *      before any holder accepts the token, otherwise XRPL refuses to
 *      flip RequireAuth on an issuer that already has trustlines).
 *   2. Server and client `acceptToken` -> the trustline lands at
 *      `pending_authorization` (line exists, but cannot hold balance
 *      until the issuer signs `tfSetfAuth`).
 *   3. Issuer attempts to credit the client BEFORE authorizing -- with
 *      RequireAuth set and the line unauthorized there is no usable path,
 *      so the ledger answers `tecPATH_DRY`. Fail-fix-validate.
 *   4. Issuer `authorize`s both holders. The trustline flips from
 *      `authorized: false` to `authorized: true`.
 *   5. Issuer credits the client and the regular MPP charge flow
 *      runs -- 10 USD goes from client to server.
 *
 * Zero `xrpl` import: every XRPL call is funnelled through the
 * Wallet API.
 *
 * Run: npx tsx demo/iou-allowlist.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store } from 'mppx/server'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../sdk/src/client/fetch.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

const PORT = 3005
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
  log.box(['XRPL MPP Demo -- IOU allowlist (RequireAuth)'])
  log.separator()

  log.loading('Funding 3 wallets via the testnet faucet (issuer, server, client)...')
  const [issuer, server, payer] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])

  log.wallet('Issuer', issuer.address)
  log.wallet('Server', server.address)
  log.wallet('Client', payer.address)
  log.separator()

  const usd = { currency: 'USD', issuer: issuer.address }

  // ---- Step 1 -- issuer flips DefaultRipple + RequireAuth ----
  log.loading('Issuer sets DefaultRipple + RequireAuth (must be done before any trustline)...')
  const rippling = await issuer.enableTransfers({ network: NETWORK })
  log.tx(rippling.hash, log.explorerLink(rippling.hash))
  const requireAuth = await issuer.requireAuthorization(true, { network: NETWORK })
  log.tx(requireAuth.hash, log.explorerLink(requireAuth.hash))
  log.success('Issuer is now an allowlisted issuer.')
  log.separator()

  // ---- Step 2 -- holders accept (lands as pending_authorization) ----
  log.loading('Server + client accept USD (line lands at pending_authorization)...')
  const [serverAccept, clientAccept] = await Promise.all([
    server.acceptToken(usd, { network: NETWORK, limit: '1000000' }),
    payer.acceptToken(usd, { network: NETWORK, limit: '1000000' }),
  ])
  if ('hash' in serverAccept && serverAccept.hash) {
    log.tx(serverAccept.hash, log.explorerLink(serverAccept.hash))
  }
  if ('hash' in clientAccept && clientAccept.hash) {
    log.tx(clientAccept.hash, log.explorerLink(clientAccept.hash))
  }
  log.info(`Server  -> ${serverAccept.status}`)
  log.info(`Client  -> ${clientAccept.status}`)

  const serverLineBefore = await server.holdsToken(usd, { network: NETWORK })
  const clientLineBefore = await payer.holdsToken(usd, { network: NETWORK })
  log.key(
    'Server line authorized?',
    String((serverLineBefore as { authorized?: boolean })?.authorized ?? 'n/a'),
  )
  log.key(
    'Client line authorized?',
    String((clientLineBefore as { authorized?: boolean })?.authorized ?? 'n/a'),
  )
  log.separator()

  // ---- Step 3 -- issuer attempts to credit client BEFORE authorizing (FAIL) ----
  log.loading('Issuer tries to credit client BEFORE authorizing (must fail)...')
  try {
    await issuer.issue(payer.address, '1000', usd, { network: NETWORK })
    log.error('Issue unexpectedly succeeded against an unauthorized trustline.')
  } catch (err) {
    const message = (err as Error).message
    log.error(message.slice(0, 200))
    // The ledger reports this as tecPATH_DRY rather than tecNO_AUTH: with
    // RequireAuth set and the line still unauthorized, there is no usable path
    // to the holder at all, so the failure surfaces as a dry path.
    log.fix('Rejected: the trustline is not authorized yet -- the issuer must authorize it.')
  }
  log.separator()

  // ---- Step 4 -- issuer authorizes both holders (FIX) ----
  log.loading('Issuer authorizes server + client (TrustSet tfSetfAuth on each line)...')
  const [authServer, authClient] = await Promise.all([
    issuer.authorize(server.address, usd, { network: NETWORK }),
    issuer.authorize(payer.address, usd, { network: NETWORK }),
  ])
  log.tx(authServer.hash, log.explorerLink(authServer.hash))
  log.tx(authClient.hash, log.explorerLink(authClient.hash))

  const serverLineAfter = await server.holdsToken(usd, { network: NETWORK })
  const clientLineAfter = await payer.holdsToken(usd, { network: NETWORK })
  log.key(
    'Server line authorized?',
    String((serverLineAfter as { authorized?: boolean })?.authorized ?? 'n/a'),
  )
  log.key(
    'Client line authorized?',
    String((clientLineAfter as { authorized?: boolean })?.authorized ?? 'n/a'),
  )
  log.separator()

  // ---- Step 5 -- issuer credits client + run MPP charge ----
  log.loading('Issuer credits the client with 1000 USD...')
  const issued = await issuer.issue(payer.address, '1000', usd, { network: NETWORK })
  log.tx(issued.hash, log.explorerLink(issued.hash))
  log.separator()

  const currencyJson = JSON.stringify(usd)
  const chargeMethod = serverCharge({
    recipient: server.address,
    currency: usd,
    network: NETWORK,
    store: Store.memory(),
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
  })

  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [chargeMethod],
  })
  const handler = mppx['xrpl/charge']({
    recipient: server.address,
    amount: '10',
    currency: currencyJson,
  })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge('Payment required -- 10 USD on an allowlisted issuer')
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('IOU payment verified on allowlisted issuer')
      // The receipt rides on the Payment-Receipt header of the response we
      // build here. `result` carries no receipt field, so the old
      // `result.receipt?.reference` was always undefined and this link
      // never printed.
      const paidResponse = result.withReceipt(
        Response.json({
          message: 'Access granted -- paid 10 USD via allowlisted issuer',
          content: 'Hello allowlisted XRPL!',
        }),
      ) as Response
      const receipt = Receipt.fromResponse(paidResponse)
      if (receipt.reference) {
        log.tx(receipt.reference, log.explorerLink(receipt.reference))
      }
      log.response(200, 'access granted')
      await sendWebResponse(paidResponse, res)
      return
    }
    res.statusCode = 404
    res.end('Not found')
  })

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))
  log.server(`Server listening on http://localhost:${PORT}`)

  const cliMethod = clientCharge({ wallet: payer, mode: 'pull', network: NETWORK })
  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  ClientMppx.create({ methods: [cliMethod] })

  log.loading(`Requesting http://localhost:${PORT}/resource...`)
  const response = await fetch(`http://localhost:${PORT}/resource`)

  if (response.ok) {
    const body = (await response.json()) as { message: string; content: string }
    log.success(body.message)
    log.info(`Content: ${body.content}`)
    const receiptHeader = response.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const receipt = Receipt.deserialize(receiptHeader)
      log.tx(receipt.reference, log.explorerLink(receipt.reference))
    }
  } else {
    log.error(`Failed: ${response.status} ${await response.text()}`)
  }

  httpServer.close()
  log.separator()
  log.info('IOU allowlist demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`)
  process.exit(1)
})
