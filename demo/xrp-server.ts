/**
 * XRP Charge -- Server
 * Generates a recipient wallet, starts HTTP server, serves a 402-gated resource.
 * Run: npx tsx demo/xrp-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../sdk/src/server/Charge.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

async function main() {
  log.box(['XRPL MPP Server -- XRP Charge'])
  log.separator()

  log.loading('Funding recipient wallet via faucet...')
  const wallet = await Wallet.fromFaucet({ network: 'testnet' })

  log.wallet('Recipient', wallet.address)
  log.separator()

  const store = Store.memory()
  const chargeMethod = charge({
    recipient: wallet.address,
    network: 'testnet',
    store,
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
  })

  const mppx = Mppx.create({
    secretKey: demoSecretKey(),
    methods: [chargeMethod],
  })

  const handler = mppx['xrpl/charge']({
    recipient: wallet.address,
    amount: '1000000',
    currency: 'XRP',
  })

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

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/'

    if (path === '/' || path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const webReq = toWebRequest(req)
      const result = await handler(webReq)

      if (result.status === 402) {
        log.challenge('Payment required -- 1,000,000 drops (1 XRP)')
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }

      log.verify('Verifying payment credential...')
      log.success('Payment verified')
      // The receipt rides on the Payment-Receipt header of the response we
      // build here. `result` carries no receipt field, so the old
      // `result.receipt?.reference` was always undefined and this link
      // never printed.
      const paidResponse = result.withReceipt(
        Response.json({ message: 'Access granted -- paid 1 XRP', content: 'Hello XRPL!' }),
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

  server.listen(3000, () => {
    log.separator()
    log.box([
      'Endpoints:',
      '',
      'GET /resource  ->  charge 1 XRP (1,000,000 drops)',
      '',
      'Waiting for requests...',
    ])
    log.separator()
    log.server('Listening on http://localhost:3000')
  })
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
