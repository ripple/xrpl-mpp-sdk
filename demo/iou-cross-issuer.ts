/**
 * Cross-issuer IOU Charge -- All-in-one demo
 *
 * Setup:
 *   - issuerA emits USD.A
 *   - issuerB emits USD.B
 *   - market maker (MM) trusts both issuers and posts a parity offer
 *     bridging USD.A <-> USD.B
 *   - sender holds USD.A only
 *   - recipient holds USD.B only
 *
 * The SDK auto-resolves the path via ripple_path_find, attaches Paths +
 * SendMax (with the default 0.5% slippage buffer), and the recipient is
 * credited with USD.B even though sender never holds USD.B directly.
 *
 * Run: npx tsx demo/iou-cross-issuer.ts
 *
 * Note: `OfferCreate` is the only operation still routed through a raw
 * xrpl.Client -- order book primitives are intentionally outside the SDK
 * abstraction surface for now. Everything trustline-related goes through
 * the Wallet API.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store } from 'mppx/server'
import { Client } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { bufferChallengeResponses } from '../sdk/src/client/fetch.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

const PORT = 3003
// Cross-issuer routing relies on the rippled `ripple_path_find` indexer.
// Devnet's indexer surfaces freshly-created orderbooks within a few seconds;
// public testnet's is materially slower and frequently returns empty until
// the offer ages by ~minutes. For a self-contained one-command demo we use
// devnet so the run finishes in under a minute.
const NETWORK = 'devnet' as const

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

function explorer(hash: string): string {
  return `${XRPL_EXPLORER_URLS[NETWORK]}${hash}`
}

async function main() {
  log.box(['XRPL MPP Demo -- Cross-issuer IOU Charge'])
  log.separator()

  log.loading(
    `Funding 5 wallets via the ${NETWORK} faucet (issuerA, issuerB, MM, sender, recipient)...`,
  )
  const [issuerA, issuerB, mm, sender, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])

  log.wallet('IssuerA  ', issuerA.address)
  log.wallet('IssuerB  ', issuerB.address)
  log.wallet('Market mkr', mm.address)
  log.wallet('Sender   ', sender.address)
  log.wallet('Recipient', recipient.address)
  log.separator()

  const usdA = { currency: 'USD', issuer: issuerA.address }
  const usdB = { currency: 'USD', issuer: issuerB.address }

  log.loading('Issuers (and MM) enable transfers (asfDefaultRipple)...')
  for (const w of [issuerA, issuerB, mm]) {
    const r = await w.enableTransfers({ network: NETWORK })
    log.tx(r.hash, explorer(r.hash))
  }

  log.loading('MM accepts USD.A and USD.B; sender accepts USD.A; recipient accepts USD.B...')
  await Promise.all([
    mm.acceptToken(usdA, { network: NETWORK, limit: '10000' }),
    mm.acceptToken(usdB, { network: NETWORK, limit: '10000' }),
    sender.acceptToken(usdA, { network: NETWORK, limit: '10000' }),
    recipient.acceptToken(usdB, { network: NETWORK, limit: '10000' }),
  ])

  log.loading(
    'Issuers fund MM with 5000 USD on each side, then issuerA credits sender with 200 USD.A...',
  )
  await Promise.all([
    issuerA.issue(mm.address, '5000', usdA, { network: NETWORK }),
    issuerB.issue(mm.address, '5000', usdB, { network: NETWORK }),
  ])
  const seed = await issuerA.issue(sender.address, '200', usdA, { network: NETWORK })
  log.tx(seed.hash, explorer(seed.hash))

  log.loading('MM places parity offer bridging USD.A -> USD.B (1:1)...')
  // Order book primitives are not yet covered by the SDK abstraction.
  const xrpl = new Client(XRPL_RPC_URLS[NETWORK], { timeout: 60_000 })
  await xrpl.connect()
  try {
    const offerResult = await xrpl.submitAndWait(
      {
        TransactionType: 'OfferCreate',
        Account: mm.address,
        TakerGets: { currency: 'USD', issuer: issuerB.address, value: '500' },
        TakerPays: { currency: 'USD', issuer: issuerA.address, value: '500' },
      },
      { wallet: mm._xrplWallet },
    )
    const offerMeta = offerResult.result.meta as any
    if (offerMeta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`OfferCreate failed: ${offerMeta?.TransactionResult ?? 'unknown'}`)
    }
    log.tx(offerResult.result.hash, explorer(offerResult.result.hash))
  } finally {
    await xrpl.disconnect()
  }

  // Give the path indexer a moment to pick up the new offer. Testnet's path
  // finder is fed asynchronously and can take several seconds to surface a
  // freshly-created order book. Skipping this means the first ripple_path_find
  // calls return zero alternatives.
  log.loading('Waiting for path indexer to surface the new offer...')
  await new Promise((r) => setTimeout(r, 6_000))

  log.separator()

  // Snapshot pre-payment balances for the realised-slippage report.
  const senderUsdABefore = (await sender.holdsToken(usdA, { network: NETWORK }))?.balance ?? '0'
  const recipientUsdBBefore =
    (await recipient.holdsToken(usdB, { network: NETWORK }))?.balance ?? '0'

  // Recipient's currency is USD.B. The challenge advertises that.
  const destCurrencyJson = JSON.stringify(usdB)
  const desiredAmount = '10' // 10 USD.B delivered to recipient

  const chargeMethod = serverCharge({
    recipient: recipient.address,
    currency: usdB,
    network: NETWORK,
    store: Store.memory(),
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
  })

  const mppx = Mppx.create({ secretKey: demoSecretKey(), methods: [chargeMethod] })
  const handler = mppx['xrpl/charge']({
    recipient: recipient.address,
    amount: desiredAmount,
    currency: destCurrencyJson,
  })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge(`Payment required -- ${desiredAmount} USD.B from issuerB`)
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('Cross-issuer payment verified')
      // The receipt rides on the Payment-Receipt header of the response we
      // build here. `result` carries no receipt field, so the old
      // `result.receipt?.reference` was always undefined and this link
      // never printed.
      const paidResponse = result.withReceipt(
        Response.json({
          message: `Access granted -- paid ${desiredAmount} USD.B (sender held only USD.A)`,
          content: 'Hello cross-issuer XRPL!',
        }),
      ) as Response
      const receipt = Receipt.fromResponse(paidResponse)
      if (receipt.reference) {
        log.tx(receipt.reference, explorer(receipt.reference))
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

  // Set up the client. Default slippage 50 bps. The onProgress callback
  // captures the path-find resolution so we can print "source amount actually
  // debited" later.
  let resolved: { strategy?: string; sourceAmountValue?: string; sourceAmountCurrency?: string } =
    {}
  const clientMethod = clientCharge({
    wallet: sender,
    mode: 'pull',
    network: NETWORK,
    slippageBps: 50,
    // Testnet's path indexer is slower than devnet -- give it more headroom
    // before declaring no path. Total budget: ~30s of retry sleep across
    // four attempts.
    pathFindRetryDelaysMs: [2_000, 4_000, 8_000, 16_000],
    onProgress: (e) => {
      if (e.type === 'paths_resolved') {
        resolved = {
          strategy: e.strategy,
          sourceAmountValue: e.sourceAmountValue,
          sourceAmountCurrency: e.sourceAmountCurrency,
        }
      }
    },
  })
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
      log.tx(receipt.reference, explorer(receipt.reference))
    }
  } else {
    log.error(`Failed: ${response.status} ${await response.text()}`)
  }

  // Realised-slippage report.
  const senderUsdAAfter = (await sender.holdsToken(usdA, { network: NETWORK }))?.balance ?? '0'
  const recipientUsdBAfter =
    (await recipient.holdsToken(usdB, { network: NETWORK }))?.balance ?? '0'
  const debitedFromSender = (Number(senderUsdABefore) - Number(senderUsdAAfter)).toFixed(6)
  const deliveredToRecipient = (Number(recipientUsdBAfter) - Number(recipientUsdBBefore)).toFixed(6)
  const realizedSlippageBps = Math.round(
    ((Number(debitedFromSender) - Number(deliveredToRecipient)) /
      Math.max(Number(deliveredToRecipient), 1e-9)) *
      10_000,
  )

  log.separator()
  log.box([
    'Cross-issuer payment summary',
    '',
    `Path strategy:        ${resolved.strategy ?? 'n/a'}`,
    `Source debited:       ${debitedFromSender} USD.A`,
    `Destination delivered: ${deliveredToRecipient} USD.B`,
    `Pre-slippage source:  ${resolved.sourceAmountValue ?? 'n/a'} ${resolved.sourceAmountCurrency ?? ''}`,
    `Realised slippage:    ${realizedSlippageBps} bps (default cap 50 bps)`,
  ])

  httpServer.close()
  log.separator()
  log.info('Cross-issuer IOU charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
