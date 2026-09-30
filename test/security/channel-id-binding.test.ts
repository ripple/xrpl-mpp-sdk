import { Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const PINNED = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/**
 * A voucher must be redeemed against the channel it was asked for.
 *
 * The verifier takes the channel from `payload.channelId`, which the payer
 * controls, while the challenge and the route each state one of their own. With
 * nothing comparing them, a route that bills one specific channel is not
 * actually pinned to it: the payer signs a valid claim on a different channel of
 * its own and is served.
 *
 * Funds still reach the right recipient from the right funder, since those are
 * checked against the ledger entry. What breaks is the pinning itself, so a
 * server that tracks per-channel terms, budgets or deposits cannot rely on
 * getting the channel it named.
 *
 * An empty `channelId` is how a challenge says "no channel pinned", which is the
 * open flow, so it must stay free for the payer to choose.
 */
function ledgerEntry(funder: Wallet, recipient: string) {
  return {
    Account: funder.address,
    Destination: recipient,
    Amount: '10000000',
    Balance: '0',
    SettleDelay: 3600,
    Expiration: null,
    CancelAfter: null,
    PublicKey: funder.publicKey,
  }
}

/**
 * `challengeChannel` is what the challenge names; `payloadChannel` is what the
 * credential presents. The claim is signed over `payloadChannel`, so the
 * signature check passes and only the binding can catch the substitution.
 */
function voucher(params: {
  funder: Wallet
  recipient: string
  challengeChannel: string
  payloadChannel: string
}) {
  const { funder, recipient, challengeChannel, payloadChannel } = params
  const signature = funder.signChannelClaim(payloadChannel, '100000')
  const challenge = {
    id: `bind-${challengeChannel.slice(0, 4)}-${payloadChannel.slice(0, 4)}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: '100000',
      channelId: challengeChannel,
      recipient,
      methodDetails: { network: 'testnet', cumulativeAmount: '0' },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId: payloadChannel, amount: '100000', signature },
    source: `did:pkh:xrpl:testnet:${funder.address}`,
  })
  return { challenge, cred }
}

function server(recipient: Wallet, funder: Wallet) {
  return serverChannel({
    recipient: recipient.address,
    network: 'testnet',
    store: Store.memory(),
    storeDurability: 'process-local',
    // Answers for any channel id, as a public node would for two channels the
    // same funder opened to the same recipient.
    channelLookup: vi.fn(async () => ledgerEntry(funder, recipient.address)) as any,
  })
}

describe('a voucher is bound to the channel it was asked for', () => {
  it('refuses a payload naming a different channel than the challenge pinned', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      challengeChannel: PINNED,
      payloadChannel: OTHER,
    })

    await expect(
      server(recipient, funder).verify({
        credential: v.cred as any,
        request: v.challenge.request,
      }),
    ).rejects.toThrow(/channel/i)
  })

  it('accepts a payload naming the pinned channel', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      challengeChannel: PINNED,
      payloadChannel: PINNED,
    })

    const receipt = await server(recipient, funder).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('treats two hex spellings of one channel as the same channel', async () => {
    // Hex is case-insensitive as a value, and the store canonicalises its keys,
    // so comparing literally would refuse a payer that agrees with the server.
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      challengeChannel: PINNED.toLowerCase(),
      payloadChannel: PINNED.toUpperCase(),
    })

    const receipt = await server(recipient, funder).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('lets the payer choose when the challenge pins no channel', async () => {
    // An empty `channelId` is the open flow's "none yet"; constraining it would
    // break resuming onto a channel the server has never named.
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      challengeChannel: '',
      payloadChannel: OTHER,
    })

    const receipt = await server(recipient, funder).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('refuses a challenge naming a different channel than the route bills', async () => {
    // Defence in depth for a direct `verify()` call, where nothing re-derives
    // the route's own challenge: the same reason the priced fields are compared.
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      challengeChannel: OTHER,
      payloadChannel: OTHER,
    })

    await expect(
      server(recipient, funder).verify({
        credential: v.cred as any,
        request: { ...v.challenge.request, channelId: PINNED },
      }),
    ).rejects.toThrow(/channelId/)
  })

  it('does not treat a route that pins no channel as a demand', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const v = voucher({
      funder,
      recipient: recipient.address,
      challengeChannel: OTHER,
      payloadChannel: OTHER,
    })

    const receipt = await server(recipient, funder).verify({
      credential: v.cred as any,
      request: { ...v.challenge.request, channelId: '' },
    })
    expect(receipt.status).toBe('success')
  })
})
