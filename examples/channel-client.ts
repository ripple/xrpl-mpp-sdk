/**
 * Minimal XRPL MPP channel client.
 *
 * Opens a PayChannel, configures the server, makes 3 paid requests.
 *
 * Usage:
 *   XRPL_SEED=sEdYourSeed XRPL_DEST=rServerAddress npx tsx examples/channel-client.ts
 *
 * Requires examples/channel-server.ts running on localhost:3001.
 */

import { Mppx } from 'mppx/client'
import { channel, openChannel } from '../sdk/src/channel/client/Channel.js'
import { challengeSafeFetch } from '../sdk/src/client/fetch.js'
import { Wallet } from '../sdk/src/utils/wallet.js'

const SEED = process.env.XRPL_SEED
const DEST = process.env.XRPL_DEST

if (!SEED || !DEST) {
  console.error(
    'Usage: XRPL_SEED=sEdXxx XRPL_DEST=rServerAddress npx tsx examples/channel-client.ts',
  )
  process.exit(1)
}

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001'
const wallet = Wallet.fromSeed(SEED)
console.log(`Using XRPL account: ${wallet.address}`)

// 1. Open a 5 XRP channel
console.log('\nOpening PaymentChannel (5 XRP)...')
const { channelId, txHash } = await openChannel({
  wallet,
  destination: DEST,
  amount: '5000000',
  settleDelay: 3600,
  network: 'testnet',
})
console.log(`Channel: ${channelId}`)
console.log(`Create tx: https://testnet.xrpl.org/transactions/${txHash}`)

// 2. Tell the server about the channel
const rawFetch = globalThis.fetch
await rawFetch(`${SERVER_URL}/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // Only the channelId. The server knows its own recipient address and must
  // not take it from us -- see the note at the top of channel-server.ts.
  body: JSON.stringify({ channelId }),
})
console.log('Server configured\n')

// 3. Patch fetch for auto 402 handling
// `challengeSafeFetch` works around an upstream mppx bug: it re-clones the 402
// while the credential is being signed, and the first clone has by then
// disturbed the body. `polyfill: false` keeps globalThis.fetch untouched, so
// payment handling is scoped to this client rather than the whole process.
const mppx = Mppx.create({
  fetch: challengeSafeFetch(),
  polyfill: false,
  methods: [channel({ wallet, network: 'testnet' })],
})

// 4. Make 3 paid requests
for (let i = 1; i <= 3; i++) {
  const response = await mppx.fetch(`${SERVER_URL}/resource`)
  const data = await response.json()
  console.log(`Request ${i}: ${response.status} -- ${JSON.stringify(data)}`)
}

process.exit(0)
