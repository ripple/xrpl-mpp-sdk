/**
 * XRP Charge -- Client
 * Generates a payer wallet, sends a paid request to the server.
 * Run: npx tsx demo/xrp-client.ts
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../sdk/src/client/fetch.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'

async function main() {
  log.box(['XRPL MPP Client -- XRP Charge'])
  log.separator()

  log.loading('Funding payer wallet via faucet...')
  const wallet = await Wallet.fromFaucet({ network: 'testnet' })

  log.wallet('Payer', wallet.address)
  log.separator()

  const chargeMethod = charge({
    wallet,
    mode: 'pull',
    network: 'testnet',
  })

  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  Mppx.create({ methods: [chargeMethod] })

  log.loading('Requesting http://localhost:3000/resource...')
  const response = await fetch('http://localhost:3000/resource')

  log.info(`Response status: ${response.status}`)

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
    log.error(`Request failed: ${response.status}`)
  }

  log.separator()
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
