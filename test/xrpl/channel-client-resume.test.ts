import { Credential } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel as clientChannel } from '../../sdk/src/channel/client/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const CHANNEL = 'a'.repeat(64)

/**
 * A server that accepts channels from callers it has not met can advertise no
 * channel, and then reports no cumulative either -- it has nothing to look the
 * mark up by. Both gaps are the client's to fill: it opened the channel, and it
 * knows what it has signed.
 */
function challenge(params: { channelId: string; amount: string; cumulative?: string }) {
  const { channelId, amount, cumulative } = params
  return {
    id: `cl-${channelId.slice(0, 6)}-${amount}-${cumulative ?? 'none'}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount,
      channelId,
      recipient: 'rRecipientPlaceholder',
      methodDetails: { network: NETWORK, ...(cumulative ? { cumulativeAmount: cumulative } : {}) },
    },
  }
}

async function credentialFor(method: any, ch: ReturnType<typeof challenge>, context?: any) {
  const blob = await method.createCredential({ challenge: ch as any, context })
  return Credential.deserialize(blob) as any
}

describe('client fills in what an open server cannot advertise', () => {
  it('signs for the configured channel when the challenge names none', async () => {
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    const cred = await credentialFor(method, challenge({ channelId: '', amount: '100000' }))

    expect(cred.payload.channelId).toBe(CHANNEL)
    // Signed over the channel we supplied, so it verifies against its key.
    expect(cred.payload.signature).toBe(wallet.signChannelClaim(CHANNEL, '100000'))
  })

  it('prefers a per-request channelId over the configured one', async () => {
    const wallet = Wallet.generate()
    const other = 'b'.repeat(64)
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    const cred = await credentialFor(method, challenge({ channelId: '', amount: '100000' }), {
      channelId: other,
    })

    expect(cred.payload.channelId).toBe(other)
  })

  it('lets a challenge that names a channel win', async () => {
    // The server stating which channel it charges through is not something the
    // client should quietly override.
    const wallet = Wallet.generate()
    const advertised = 'c'.repeat(64)
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    const cred = await credentialFor(method, challenge({ channelId: advertised, amount: '100000' }))

    expect(cred.payload.channelId).toBe(advertised)
  })

  it('says so when no channel is available from anywhere', async () => {
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet, network: NETWORK })

    await expect(
      credentialFor(method, challenge({ channelId: '', amount: '100000' })),
    ).rejects.toThrow(/no channelId/)
  })

  it('resumes from its own cumulative when the challenge reports none', async () => {
    // Without this the client re-signs the same cumulative on every request,
    // and the second is refused as a replay -- correctly, since a cumulative
    // must strictly increase.
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    const amounts: string[] = []
    for (let i = 0; i < 3; i++) {
      const cred = await credentialFor(method, challenge({ channelId: '', amount: '100000' }))
      amounts.push(cred.payload.amount)
    }

    expect(amounts).toEqual(['100000', '200000', '300000'])
  })

  it('takes the challenge cumulative when it is ahead of ours', async () => {
    // The server's high-water mark stays the authority: a client that fell
    // behind, or restarted, resumes from what it is told.
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    const first = await credentialFor(method, challenge({ channelId: '', amount: '100000' }))
    expect(first.payload.amount).toBe('100000')

    const ahead = await credentialFor(
      method,
      challenge({ channelId: '', amount: '100000', cumulative: '900000' }),
    )
    expect(ahead.payload.amount).toBe('1000000')
  })

  it('keeps a separate mark per channel', async () => {
    const wallet = Wallet.generate()
    const second = 'd'.repeat(64)
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    await credentialFor(method, challenge({ channelId: '', amount: '100000' }))
    await credentialFor(method, challenge({ channelId: '', amount: '100000' }))

    // A different channel starts at zero rather than inheriting the first's
    // mark, which would sign away more than that channel was asked for.
    const other = await credentialFor(method, challenge({ channelId: second, amount: '50000' }))
    expect(other.payload.amount).toBe('50000')
  })

  it('still honours an explicit cumulativeAmount', async () => {
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet, channelId: CHANNEL, network: NETWORK })

    await credentialFor(method, challenge({ channelId: '', amount: '100000' }))
    const pinned = await credentialFor(method, challenge({ channelId: '', amount: '100000' }), {
      cumulativeAmount: '750000',
    })

    expect(pinned.payload.amount).toBe('750000')
  })
})
