import { Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHANNEL = 'a'.repeat(64)

/**
 * A session challenge must name the ledger it settles on.
 *
 * Without it the two sides each fall back to their own default, and those can
 * differ silently: a claim signed for a channel the client believes is on one
 * ledger, verified and redeemed by a server on another. It also leaves the
 * client's network pin nothing to compare against, so that guard cannot fire.
 *
 * The request schema cannot carry this requirement. It validates what a route
 * supplies, and the server fills `network` in its `request` hook rather than
 * making every route repeat what the server already knows. So the rule is
 * enforced at verification, where the emitted challenge is what arrives.
 */
function voucher(params: {
  funder: Wallet
  recipient: string
  methodDetails?: Record<string, unknown>
}) {
  const { funder, recipient, methodDetails } = params
  const signature = funder.signChannelClaim(CHANNEL, '100000')
  const challenge = {
    id: `net-${Math.trunc(Number(process.hrtime.bigint() % 100000n))}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: '100000',
      channelId: CHANNEL,
      recipient,
      ...(methodDetails ? { methodDetails } : {}),
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId: CHANNEL, amount: '100000', signature },
    source: `did:pkh:xrpl:testnet:${funder.address}`,
  })
  return { challenge, cred }
}

function server(recipient: Wallet, funder: Wallet, network: 'testnet' | 'devnet' = 'testnet') {
  return serverChannel({
    recipient: recipient.address,
    network,
    store: Store.memory(),
    storeDurability: 'process-local',
    channelLookup: vi.fn(async () => ({
      Account: funder.address,
      Destination: recipient.address,
      Amount: '10000000',
      Balance: '0',
      SettleDelay: 3600,
      Expiration: null,
      CancelAfter: null,
      PublicKey: funder.publicKey,
    })) as any,
  })
}

describe('a session challenge must name its network', () => {
  it('refuses a challenge with no methodDetails at all', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({ funder, recipient: recipient.address })

    await expect(
      server(recipient, funder).verify({
        credential: v.cred as any,
        request: v.challenge.request,
      }),
    ).rejects.toThrow(/carries no `methodDetails.network`/)
  })

  it('refuses a challenge whose methodDetails omits the network', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      methodDetails: { cumulativeAmount: '0' },
    })

    await expect(
      server(recipient, funder).verify({
        credential: v.cred as any,
        request: v.challenge.request,
      }),
    ).rejects.toThrow(/carries no `methodDetails.network`/)
  })

  it('refuses a challenge for a different network than the server settles on', async () => {
    // Reachable when two deployments share a secret and settle on different
    // ledgers: the challenge is authentic, and for the wrong chain.
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      methodDetails: { network: 'devnet', cumulativeAmount: '0' },
    })

    await expect(
      server(recipient, funder, 'testnet').verify({
        credential: v.cred as any,
        request: v.challenge.request,
      }),
    ).rejects.toThrow(/for the devnet network but this server settles on testnet/)
  })

  it('accepts a challenge naming the server network', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      methodDetails: { network: 'testnet', cumulativeAmount: '0' },
    })

    const receipt = await server(recipient, funder, 'testnet').verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('the server fills the network itself, so a route need not', async () => {
    // The reason the schema leaves it optional: a route states the price, the
    // server states the ledger.
    const { Mppx } = await import('mppx/server')
    const recipient = Wallet.generate()
    const mppx = Mppx.create({
      secretKey: 'a'.repeat(32),
      methods: [
        serverChannel({
          recipient: recipient.address,
          network: 'devnet',
          store: Store.memory(),
          storeDurability: 'process-local',
        }),
      ],
    })
    const handler = mppx['xrpl/session']({
      amount: '100000',
      channelId: CHANNEL,
      recipient: recipient.address,
    })

    const result: any = await handler(new Request('http://example.test/r'))
    const header = (result.challenge as Response).headers.get('WWW-Authenticate') ?? ''
    const encoded = header.match(/request="([^"]+)"/)?.[1] ?? ''
    const request = JSON.parse(Buffer.from(encoded, 'base64url').toString())

    expect(request.methodDetails.network).toBe('devnet')
  })
  it('refuses a claim at or below what the channel has already delivered', async () => {
    // Such a claim redeems nothing: the ledger transfers `claimed - Balance`.
    // Monotonicity does not catch it, since that compares against this
    // server's own mark, and Balance runs ahead of the mark whenever a claim
    // is redeemed outside this exchange.
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const method = serverChannel({
      recipient: recipient.address,
      network: 'testnet',
      store: Store.memory(),
      storeDurability: 'process-local',
      channelLookup: vi.fn(async () => ({
        Account: funder.address,
        Destination: recipient.address,
        Amount: '10000000',
        Balance: '500000',
        SettleDelay: 3600,
        Expiration: null,
        CancelAfter: null,
        PublicKey: funder.publicKey,
      })) as any,
    })

    const v = voucher({
      funder,
      recipient: recipient.address,
      methodDetails: { network: 'testnet', cumulativeAmount: '0' },
    })

    await expect(
      method.verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/not above the 500000 drops this channel has already delivered/)
  })
})
