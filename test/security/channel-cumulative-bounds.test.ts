import { Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHANNEL = 'a'.repeat(64)

/**
 * A cumulative claim sits between two bounds on the ledger entry: strictly above
 * `Balance`, which is what the channel has already delivered, and at most
 * `Amount`, which is everything it holds. `Balance` is not subtracted from
 * `Amount`, since doing so would refuse claims that are valid.
 *
 * Both bounds were enforced but neither edge was pinned by a test. A mutation
 * sweep found it: shifting either comparison by one drop left the whole suite
 * green. The two edges are where the cost sits, in opposite directions. Loosen
 * the floor and a claim that redeems nothing buys a request. Tighten the ceiling
 * and a payer that claims its entire deposit is refused.
 */
function ledgerEntry(funder: Wallet, recipient: string, amount: string, balance: string) {
  return {
    Account: funder.address,
    Destination: recipient,
    Amount: amount,
    Balance: balance,
    SettleDelay: 3600,
    Expiration: null,
    CancelAfter: null,
    PublicKey: funder.publicKey,
  }
}

function voucher(funder: Wallet, recipient: string, cumulative: string) {
  const signature = funder.signChannelClaim(CHANNEL, cumulative)
  const challenge = {
    id: `bound-${cumulative}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: cumulative,
      channelId: CHANNEL,
      recipient,
      methodDetails: { network: 'testnet', cumulativeAmount: '0' },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId: CHANNEL, amount: cumulative, signature },
    source: `did:pkh:xrpl:testnet:${funder.address}`,
  })
  return { challenge, cred }
}

async function attempt(params: { amount: string; balance: string; cumulative: string }) {
  const funder = Wallet.generate()
  const recipient = Wallet.generate()
  const method = serverChannel({
    recipient: recipient.address,
    network: 'testnet',
    store: Store.memory(),
    storeDurability: 'process-local',
    channelLookup: vi.fn(async () =>
      ledgerEntry(funder, recipient.address, params.amount, params.balance),
    ) as any,
  })
  const v = voucher(funder, recipient.address, params.cumulative)
  return method.verify({ credential: v.cred as any, request: v.challenge.request })
}

describe('the two bounds on a cumulative claim', () => {
  describe('floor: strictly above what the channel already delivered', () => {
    it('refuses a cumulative exactly equal to Balance', async () => {
      // Redeems `claimed - Balance`, so exactly zero drops. Free service.
      await expect(
        attempt({ amount: '10000000', balance: '500000', cumulative: '500000' }),
      ).rejects.toThrow(/not above the 500000 drops/)
    })

    it('accepts a cumulative one drop above Balance', async () => {
      const receipt = await attempt({
        amount: '10000000',
        balance: '500000',
        cumulative: '500001',
      })
      expect(receipt.status).toBe('success')
    })
  })

  describe('ceiling: at most the whole deposit', () => {
    it('accepts a cumulative exactly equal to Amount', async () => {
      // Claiming the entire deposit is valid, and is what a payer does on the
      // last voucher of a session.
      const receipt = await attempt({
        amount: '10000000',
        balance: '0',
        cumulative: '10000000',
      })
      expect(receipt.status).toBe('success')
    })

    it('refuses a cumulative one drop above Amount', async () => {
      await expect(
        attempt({ amount: '10000000', balance: '0', cumulative: '10000001' }),
      ).rejects.toThrow(/CHANNEL_EXHAUSTED/)
    })

    it('accepts the whole deposit even after part of it was delivered', async () => {
      // The bound is `Amount` alone. Subtracting `Balance` would make this the
      // failing case, and it is the one the specification calls out.
      const receipt = await attempt({
        amount: '10000000',
        balance: '4000000',
        cumulative: '10000000',
      })
      expect(receipt.status).toBe('success')
    })
  })
})
