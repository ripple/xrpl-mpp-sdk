/**
 * Minimal XRPL MPP charge client.
 *
 * Usage:
 *   XRPL_SEED=sEdYourSeed npx tsx examples/client.ts
 *
 * Requires examples/server.ts running on localhost:3000.
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../sdk/src/client/Charge.js'
import { challengeSafeFetch } from '../sdk/src/client/fetch.js'
import { Wallet } from '../sdk/src/utils/wallet.js'

const SEED = process.env.XRPL_SEED
if (!SEED) {
  console.error('Usage: XRPL_SEED=sEdYourSeed npx tsx examples/client.ts')
  process.exit(1)
}

const wallet = Wallet.fromSeed(SEED)
console.log(`Using XRPL account: ${wallet.address}`)

// `challengeSafeFetch` works around an upstream mppx bug: it re-clones the 402
// while the credential is being signed, and the first clone has by then
// disturbed the body. `polyfill: false` keeps globalThis.fetch untouched, so
// payment handling is scoped to this client rather than the whole process.
const mppx = Mppx.create({
  fetch: challengeSafeFetch(),
  polyfill: false,
  methods: [
    charge({
      wallet,
      mode: 'pull',
      network: 'testnet',
    }),
  ],
})

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000'

console.log(`\nRequesting ${SERVER_URL}...\n`)
const response = await mppx.fetch(SERVER_URL)
const data = await response.json()

console.log(`--- Response (${response.status}) ---`)
console.log(JSON.stringify(data, null, 2))

const receiptHeader = response.headers.get('Payment-Receipt')
if (receiptHeader) {
  const receipt = Receipt.deserialize(receiptHeader)
  console.log(`\n--- Receipt ---`)
  console.log(`Method:    ${receipt.method}`)
  console.log(`Reference: ${receipt.reference}`)
  console.log(`Explorer:  https://testnet.xrpl.org/transactions/${receipt.reference}`)
}

process.exit(0)
