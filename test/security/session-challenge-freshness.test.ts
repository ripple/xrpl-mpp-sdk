import { Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHANNEL = 'a'.repeat(64)

/**
 * What the session path does with the challenge's `expires`.
 *
 * A missing one is deliberately not fatal here, unlike on charge: the cumulative
 * high-water mark is an independent single-use control, and retention falls back
 * to unbounded, so nothing lapses. That asymmetry is a choice and is asserted
 * below so it cannot drift by accident.
 *
 * A present one is enforced, and both of its failure modes had no test. An
 * unparseable timestamp is the quieter of the two: `Date.parse` yields NaN, and
 * every comparison against NaN is false, so without the explicit guard the
 * expiry check would pass rather than refuse.
 */
function voucher(funder: Wallet, recipient: string, expires: string | undefined) {
  const signature = funder.signChannelClaim(CHANNEL, '100000')
  const challenge = {
    id: `fresh-${expires ?? 'none'}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    ...(expires === undefined ? {} : { expires }),
    request: {
      amount: '100000',
      channelId: CHANNEL,
      recipient,
      methodDetails: { network: 'testnet', cumulativeAmount: '0' },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId: CHANNEL, amount: '100000', signature },
    source: `did:pkh:xrpl:testnet:${funder.address}`,
  })
  return { challenge, cred }
}

async function attempt(expires: string | undefined) {
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
      Balance: '0',
      SettleDelay: 3600,
      Expiration: null,
      CancelAfter: null,
      PublicKey: funder.publicKey,
    })) as any,
  })
  const v = voucher(funder, recipient.address, expires)
  return method.verify({ credential: v.cred as any, request: v.challenge.request })
}

describe('session challenge freshness', () => {
  it('refuses an expires it cannot parse', async () => {
    await expect(attempt('not-a-timestamp')).rejects.toThrow(/malformed expires/)
  })

  it('refuses an expires that has already passed', async () => {
    await expect(attempt(new Date(Date.now() - 60_000).toISOString())).rejects.toThrow(/expired at/)
  })

  it('accepts an expires still in the future', async () => {
    const receipt = await attempt(new Date(Date.now() + 60_000).toISOString())
    expect(receipt.status).toBe('success')
  })

  it('accepts a challenge with no expires, warning rather than refusing', async () => {
    // The documented asymmetry with charge. If this ever starts rejecting, the
    // change is intentional and the reasoning in the verifier needs rewriting
    // with it.
    const receipt = await attempt(undefined)
    expect(receipt.status).toBe('success')
  })
})
