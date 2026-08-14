/**
 * IOU Charge -- All-in-one demo
 *
 * Setup phase uses only the SDK Wallet API (no `xrpl` import). The issuer
 * enables transfers, holders accept the token, the issuer credits the payer,
 * and then the regular MPP charge flow runs end-to-end.
 *
 * Run: npx tsx demo/iou-charge.ts
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

const PORT = 3001
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
  log.box(['XRPL MPP Demo -- IOU Charge (all-in-one)'])
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

  const currency = { currency: 'USD', issuer: issuer.address }

  log.loading('Issuer enables transfers (asfDefaultRipple)...')
  const transfers = await issuer.enableTransfers({ network: NETWORK })
  log.tx(transfers.hash, log.explorerLink(transfers.hash))

  log.loading('Server accepts USD...')
  const accepted1 = await server.acceptToken(currency, { network: NETWORK, limit: '1000000' })
  if ('hash' in accepted1 && accepted1.hash) {
    log.tx(accepted1.hash, log.explorerLink(accepted1.hash))
  }
  log.success(`Server -> ${accepted1.status}`)

  log.loading('Client accepts USD...')
  const accepted2 = await payer.acceptToken(currency, { network: NETWORK, limit: '1000000' })
  if ('hash' in accepted2 && accepted2.hash) {
    log.tx(accepted2.hash, log.explorerLink(accepted2.hash))
  }
  log.success(`Client -> ${accepted2.status}`)

  log.loading('Issuer credits the client with 1000 USD...')
  const issued = await issuer.issue(payer.address, '1000', currency, { network: NETWORK })
  log.tx(issued.hash, log.explorerLink(issued.hash))

  log.separator()

  const currencyJson = JSON.stringify(currency)

  const chargeMethod = serverCharge({
    recipient: server.address,
    currency,
    network: NETWORK,
    store: Store.memory(),
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
  })

  const mppx = Mppx.create({ secretKey: demoSecretKey(), methods: [chargeMethod] })
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
        log.challenge('Payment required -- 10 USD')
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('IOU payment verified')
      // The receipt rides on the Payment-Receipt header of the response we
      // build here. `result` carries no receipt field, so the old
      // `result.receipt?.reference` was always undefined and this link
      // never printed.
      const paidResponse = result.withReceipt(
        Response.json({ message: 'Access granted -- paid 10 USD', content: 'Hello XRPL!' }),
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
  log.info('IOU charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
