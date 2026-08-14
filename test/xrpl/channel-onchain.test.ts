import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ChannelLookup,
  type PayChannelLedgerEntry,
  channel as serverChannel,
} from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const CHANNEL_ID = '0'.repeat(64)

function freshChannel(funder: Wallet, recipient: string, amount: string): PayChannelLedgerEntry {
  return {
    Account: funder.address,
    Destination: recipient,
    Amount: amount,
    Balance: '0',
    Expiration: null,
    CancelAfter: null,
  }
}

function buildVoucher(
  funder: Wallet,
  channelId: string,
  cumDrops: string,
  prevCumDrops: string,
  network: string,
) {
  const sig = funder.signChannelClaim(channelId, cumDrops)
  const delta = (BigInt(cumDrops) - BigInt(prevCumDrops)).toString()
  const challenge = {
    id: `ch-${cumDrops}-${Date.now()}-${Math.random()}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    request: {
      amount: delta,
      channelId,
      recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      methodDetails: { network, cumulativeAmount: prevCumDrops },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId, amount: cumDrops, signature: sig },
    source: `did:pkh:xrpl:${network}:${funder.address}`,
  })
  return { challenge, cred }
}

describe('channel server -- on-chain verification with injected lookup', () => {
  let funder: Wallet
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    funder = Wallet.generate()
    store = Store.memory()
  })

  it('first voucher hits the lookup, subsequent vouchers reuse the cache', async () => {
    const recipient = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
    const ledgerEntry = freshChannel(funder, recipient, '5000000') // 5 XRP funded
    const lookup: ChannelLookup = vi.fn(async () => ledgerEntry)

    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
    })

    const v1 = buildVoucher(funder, CHANNEL_ID, '100000', '0', NETWORK)
    const r1 = await method.verify({ credential: v1.cred as any, request: v1.challenge.request })
    expect(r1.status).toBe('success')

    const v2 = buildVoucher(funder, CHANNEL_ID, '200000', '100000', NETWORK)
    const r2 = await method.verify({ credential: v2.cred as any, request: v2.challenge.request })
    expect(r2.status).toBe('success')

    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('emits CHANNEL_EXHAUSTED when cumulative > funded balance even after a refresh', async () => {
    const recipient = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
    const ledgerEntry = freshChannel(funder, recipient, '500000') // 0.5 XRP funded
    const lookup: ChannelLookup = vi.fn(async () => ledgerEntry)

    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
    })

    // First valid voucher under cap to seed cache
    const v1 = buildVoucher(funder, CHANNEL_ID, '300000', '0', NETWORK)
    await method.verify({ credential: v1.cred as any, request: v1.challenge.request })

    // Voucher above cap -> triggers re-fetch -> still over -> CHANNEL_EXHAUSTED
    const vBig = buildVoucher(funder, CHANNEL_ID, '600000', '300000', NETWORK)
    await expect(
      method.verify({ credential: vBig.cred as any, request: vBig.challenge.request }),
    ).rejects.toThrow(/CHANNEL_EXHAUSTED/)

    // Re-fetch happened: 1 initial + 1 refresh = 2 lookups.
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('refresh detects PaymentChannelFund top-up and accepts the previously over-cap claim', async () => {
    const recipient = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
    let funded = '500000'
    const lookup: ChannelLookup = vi.fn(async () => ({
      Account: funder.address,
      Destination: recipient,
      Amount: funded,
      Balance: '0',
      Expiration: null,
      CancelAfter: null,
    }))

    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
    })

    // Seed cache at 0.5 XRP
    const v1 = buildVoucher(funder, CHANNEL_ID, '300000', '0', NETWORK)
    await method.verify({ credential: v1.cred as any, request: v1.challenge.request })

    // Funder tops up off-screen
    funded = '1000000'

    // Voucher above old cap, under new cap -> refresh succeeds
    const vBig = buildVoucher(funder, CHANNEL_ID, '900000', '300000', NETWORK)
    const r = await method.verify({
      credential: vBig.cred as any,
      request: vBig.challenge.request,
    })
    expect(r.status).toBe('success')
  })

  it('throws CHANNEL_NOT_FOUND when lookup returns null', async () => {
    const lookup: ChannelLookup = vi.fn(async () => null)

    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
    })

    const v = buildVoucher(funder, CHANNEL_ID, '100000', '0', NETWORK)
    await expect(
      method.verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/CHANNEL_NOT_FOUND/)
  })

  it('throws CHANNEL_EXPIRED when channel.Expiration has elapsed', async () => {
    const recipient = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
    const rippleEpoch = 946684800
    const expiredAt = Math.floor(Date.now() / 1000) - 60 - rippleEpoch // 60s ago
    const lookup: ChannelLookup = vi.fn(async () => ({
      Account: funder.address,
      Destination: recipient,
      Amount: '5000000',
      Balance: '0',
      Expiration: expiredAt,
      CancelAfter: null,
    }))

    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
    })

    const v = buildVoucher(funder, CHANNEL_ID, '100000', '0', NETWORK)
    await expect(
      method.verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/CHANNEL_EXPIRED|Channel.*closed/)
  })

  it('emits onDisputeDetected when channel has CancelAfter', async () => {
    const recipient = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
    const futureCancel = Math.floor(Date.now() / 1000) + 3600
    const lookup: ChannelLookup = vi.fn(async () => ({
      Account: funder.address,
      Destination: recipient,
      Amount: '5000000',
      Balance: '0',
      Expiration: null,
      CancelAfter: futureCancel,
    }))

    const onDisputeDetected = vi.fn()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
      onDisputeDetected,
    })

    const v = buildVoucher(funder, CHANNEL_ID, '100000', '0', NETWORK)
    await method.verify({ credential: v.cred as any, request: v.challenge.request })

    expect(onDisputeDetected).toHaveBeenCalledTimes(1)
    expect(onDisputeDetected).toHaveBeenCalledWith(expect.objectContaining({ balance: '5000000' }))
  })
})
