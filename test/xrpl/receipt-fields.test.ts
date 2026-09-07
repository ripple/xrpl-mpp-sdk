import { Credential, Receipt, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import type { XrplReceiptFields } from '../../sdk/src/types.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const CHANNEL_ID = 'a'.repeat(64)

/**
 * The base receipt carries one `reference`, defined by the core specification
 * as method-specific. Ours put a bare transaction hash there for a charge, a
 * `channelId:cumulative` pair for a voucher, and an `open:channelId:txHash`
 * triple for an open -- three shapes behind one name. A consumer looking for a
 * transaction hash found no field called one, and string-splitting was the
 * only way in; our own demos did exactly that.
 *
 * So the parts are named. `reference` keeps its old value throughout, since
 * the specification asks for it and something may already read it.
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

function voucher(funder: Wallet, recipient: string, cumulative: string) {
  const signature = funder.signChannelClaim(CHANNEL_ID, cumulative)
  const challenge = {
    id: `r-${cumulative}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: cumulative,
      channelId: CHANNEL_ID,
      recipient,
      methodDetails: { network: NETWORK, cumulativeAmount: '0' },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId: CHANNEL_ID, amount: cumulative, signature },
    source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
  })
  return { challenge, cred }
}

describe('receipt names its parts', () => {
  it('a voucher receipt carries channelId and cumulative', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const method = serverChannel({
      recipient: recipient.address,
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
      channelLookup: vi.fn(async () => ledgerEntry(funder, recipient.address)),
    })

    const v = voucher(funder, recipient.address, '250000')
    const receipt = (await method.verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })) as Receipt.Receipt & XrplReceiptFields

    expect(receipt.channelId).toBe(CHANNEL_ID)
    expect(receipt.cumulative).toBe('250000')
    // No transaction settles on a voucher, so there is no hash to report.
    expect(receipt.txHash).toBeUndefined()
    // And the old value is untouched.
    expect(receipt.reference).toBe(`${CHANNEL_ID}:250000`)
  })

  it('survives a serialize and parse round trip through the header', async () => {
    // The base schema is a loose object and the core spec allows methods to
    // extend it, so the added fields must not be stripped in transit. This is
    // the property the whole change rests on.
    const funder = Wallet.generate()
    const recipient = Wallet.generate()
    const method = serverChannel({
      recipient: recipient.address,
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
      channelLookup: vi.fn(async () => ledgerEntry(funder, recipient.address)),
    })

    const v = voucher(funder, recipient.address, '300000')
    const receipt = await method.verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })

    const decoded = Receipt.deserialize(Receipt.serialize(receipt)) as Receipt.Receipt &
      XrplReceiptFields

    expect(decoded.channelId).toBe(CHANNEL_ID)
    expect(decoded.cumulative).toBe('300000')
    expect(decoded.method).toBe('xrpl')
    expect(decoded.status).toBe('success')
  })
})
