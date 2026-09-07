import { Credential } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel as clientChannel } from '../../sdk/src/channel/client/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHANNEL = 'a'.repeat(64)
const MERCHANT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'

/**
 * Both cases here come from one property: the same seed controls the same
 * address on every XRPL network, and a channel ID is derived from the funder,
 * the destination and a sequence number. So a channel opened to the same
 * merchant from a fresh account has the same ID on testnet and on mainnet.
 *
 * The server already namespaces its high-water marks per network for this
 * reason. The client had to learn the same lesson twice.
 */
function challenge(params: { network: string; amount: string; recipient?: string }) {
  const { network, amount, recipient = MERCHANT } = params
  return {
    id: `n-${network}-${amount}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount,
      channelId: CHANNEL,
      recipient,
      methodDetails: { network },
    },
  }
}

async function sign(method: any, ch: ReturnType<typeof challenge>) {
  const blob = await method.createCredential({ challenge: ch as any, context: {} })
  return Credential.deserialize(blob) as any
}

describe('channel client and the network', () => {
  it('keeps its cumulative mark separate per network', async () => {
    // Shared, the second network resumes from the first's total and signs
    // above what it was asked for -- 600000 drops for a 100000 request.
    const method = clientChannel({ wallet: Wallet.generate() })

    const first = await sign(method, challenge({ network: 'testnet', amount: '500000' }))
    expect(first.payload.amount).toBe('500000')

    const second = await sign(method, challenge({ network: 'devnet', amount: '100000' }))
    expect(second.payload.amount).toBe('100000')
  })

  it('still accumulates within one network', async () => {
    const method = clientChannel({ wallet: Wallet.generate() })

    const one = await sign(method, challenge({ network: 'testnet', amount: '100000' }))
    const two = await sign(method, challenge({ network: 'testnet', amount: '100000' }))

    expect(one.payload.amount).toBe('100000')
    expect(two.payload.amount).toBe('200000')
  })

  it('refuses a challenge for a network it was pinned away from', async () => {
    // Passing `network` explicitly pins it. Without this the client follows the
    // challenge, and on an open action that deposits real XRP on a ledger the
    // caller never chose. The charge client has refused this for a while.
    const method = clientChannel({ wallet: Wallet.generate(), network: 'testnet' })

    await expect(sign(method, challenge({ network: 'mainnet', amount: '100000' }))).rejects.toThrow(
      /pinned to testnet/,
    )
  })

  it('follows the challenge when no network was pinned', async () => {
    // Not passing `network` is not a choice, so there is nothing to violate.
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet })

    const cred = await sign(method, challenge({ network: 'devnet', amount: '100000' }))
    // The DID states the network the credential is for, so assert it against
    // the wallet rather than against the value under test.
    expect(cred.source).toBe(`did:pkh:xrpl:devnet:${wallet.address}`)
  })

  it('accepts a challenge naming the network it was pinned to', async () => {
    const method = clientChannel({ wallet: Wallet.generate(), network: 'testnet' })

    const cred = await sign(method, challenge({ network: 'testnet', amount: '100000' }))
    expect(cred.payload.amount).toBe('100000')
  })
})
