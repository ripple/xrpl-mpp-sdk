/**
 * Example: Pay-per-token SSE streaming.
 *
 * This example shows how to use ChannelStream to sign claims
 * as LLM tokens arrive over a Server-Sent Events connection.
 *
 * Run: npx tsx examples/stream-llm.ts
 */
import { ChannelStream } from '../sdk/src/channel/stream.js'
import { Wallet } from '../sdk/src/utils/wallet.js'

// Generate a demo wallet (in production, use a real funded wallet)
const wallet = Wallet.generate()

const stream = new ChannelStream({
  channelId: '0'.repeat(64), // Replace with real channel ID
  privateKey: wallet.privateKey,
  dropsPerUnit: '100', // 100 drops per token (0.0001 XRP)
  granularity: 10, // Sign every 10 tokens
})

// Simulate receiving LLM tokens
const tokens = [
  'Hello',
  ' ',
  'world',
  '!',
  ' ',
  'This',
  ' ',
  'is',
  ' ',
  'a',
  ' ',
  'streaming',
  ' ',
  'response',
  ' ',
  'from',
  ' ',
  'an',
  ' ',
  'LLM',
  '.',
]

console.log('Simulating pay-per-token streaming...')
console.log('')

for (const token of tokens) {
  process.stdout.write(token)
  const claim = stream.tick(1)
  if (claim) {
    console.log(
      `\n  [claim] cumulative: ${claim.amount} drops, sig: ${claim.signature.slice(0, 16)}...`,
    )
  }
}

// Final settlement
const final = stream.sign()
console.log('')
console.log(`\nFinal settlement: ${final.amount} drops (${stream.totalUnits} tokens)`)
console.log(`Signature: ${final.signature.slice(0, 32)}...`)
