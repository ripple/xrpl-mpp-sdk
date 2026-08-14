/**
 * MPT Charge -- All-in-one demo
 * Mints an MPT issuance, authorizes the server + client, issues tokens, then
 * runs the MPP charge flow. No `xrpl` import: every XRPL call is funnelled
 * through the SDK's Wallet API.
 *
 * Run: npx tsx demo/mpt-charge.ts
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

const PORT = 3002
const NETWORK = 'testnet'

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
  log.box(['XRPL MPP Demo -- MPT Charge (all-in-one)'])
  log.separator()

  log.loading('Funding 3 wallets (issuer, server, client)...')
  const [issuer, server, payer] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Issuer', issuer.address)
  log.wallet('Server', server.address)
  log.wallet('Client', payer.address)
  log.separator()

  log.loading('Creating MPT issuance (allowlist + lockable + transferable)...')
  const { mpt, hash: createHash } = await issuer.createToken({
    assetScale: 2,
    maximumAmount: '100000000',
    requireAuthorization: true,
    allowLock: true,
    network: NETWORK,
  })
  log.success('MPTokenIssuanceCreate: tesSUCCESS')
  log.tx(createHash, log.explorerLink(createHash))
  log.key('MPTokenIssuanceID', mpt.mpt_issuance_id)

  log.loading('Holders opt in to the MPT (server + client)...')
  const [serverAccept, clientAccept] = await Promise.all([
    server.acceptToken(mpt, { network: NETWORK }),
    payer.acceptToken(mpt, { network: NETWORK }),
  ])
  if ('hash' in serverAccept && serverAccept.hash) {
    log.tx(serverAccept.hash, log.explorerLink(serverAccept.hash))
  }
  if ('hash' in clientAccept && clientAccept.hash) {
    log.tx(clientAccept.hash, log.explorerLink(clientAccept.hash))
  }
  log.success(`Server: ${serverAccept.status} -- Client: ${clientAccept.status}`)

  log.loading('Issuer authorizes both holders (allowlist)...')
  const [authServer, authClient] = await Promise.all([
    issuer.authorize(server.address, mpt, { network: NETWORK }),
    issuer.authorize(payer.address, mpt, { network: NETWORK }),
  ])
  log.tx(authServer.hash, log.explorerLink(authServer.hash))
  log.tx(authClient.hash, log.explorerLink(authClient.hash))

  log.loading('Issuing 10000 MPT to client...')
  const issued = await issuer.issue(payer.address, '10000', mpt, { network: NETWORK })
  log.success('Payment (issuance): tesSUCCESS')
  log.tx(issued.hash, log.explorerLink(issued.hash))
  log.separator()

  const chargeMethod = serverCharge({
    recipient: server.address,
    currency: mpt,
    network: NETWORK,
    store: Store.memory(),
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
  })

  const mppx = Mppx.create({ secretKey: demoSecretKey(), methods: [chargeMethod] })
  const handler = mppx['xrpl/charge']({
    recipient: server.address,
    amount: '100',
    currency: JSON.stringify(mpt),
  })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge('Payment required -- 100 MPT')
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('MPT payment verified')
      // The receipt rides on the Payment-Receipt header of the response we
      // build here. `result` carries no receipt field, so the old
      // `result.receipt?.reference` was always undefined and this link
      // never printed.
      const paidResponse = result.withReceipt(
        Response.json({ message: 'Access granted -- paid 100 MPT', content: 'Hello XRPL!' }),
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

  const clientMethod = clientCharge({ wallet: payer, mode: 'pull', network: NETWORK })
  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  ClientMppx.create({ methods: [clientMethod] })

  log.loading(`Requesting http://localhost:${PORT}/resource...`)
  const response = await fetch(`http://localhost:${PORT}/resource`)

  if (response.ok) {
    const body = (await response.json()) as any
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
  log.info('MPT charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
