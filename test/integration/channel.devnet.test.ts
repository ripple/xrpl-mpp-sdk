import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openChannel } from '../../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import type { Wallet } from '../../sdk/src/utils/wallet.js'
import { createFundedWallet, devnetSource, IT_NETWORK } from './devnet-helpers.js'

/**
 * Channel lifecycle on devnet:
 * 1. Funder opens a 5 XRP PaymentChannel to receiver.
 * 2. Funder issues 3 off-chain claims (100k -> 200k -> 300k drops).
 * 3. Server verify() accepts each claim, with on-chain verification enabled
 *    (default), so it actually does a ledger_entry RPC.
 * 4. Receiver closes the channel by submitting PaymentChannelClaim with the
 *    latest cumulative amount + signature.
 */
describe('integration: PayChannel lifecycle on devnet', () => {
  const NETWORK = IT_NETWORK
  let funder: Wallet
  let receiver: Wallet

  beforeAll(async () => {
    ;[funder, receiver] = await Promise.all([createFundedWallet(), createFundedWallet()])
  })

  afterAll(async () => {
    // Wallet helpers manage their own short-lived clients; nothing to close.
  })

  it('opens channel, accepts 3 vouchers, closes with cumulative on-chain', async () => {
    const { channelId, txHash: openTx } = await openChannel({
      wallet: funder,
      destination: receiver.address,
      amount: '5000000',
      // At or above the server's 3600s minimum. A shorter delay would let the
      // funder close and reclaim unredeemed value faster than the server can
      // detect it and submit a claim, so the server rejects vouchers on such a
      // channel -- this suite should exercise a channel a server would accept.
      settleDelay: 3600,
      network: NETWORK,
    })
    expect(openTx).toMatch(/^[0-9A-F]{64}$/)
    expect(channelId).toMatch(/^[0-9A-F]{64}$/)

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
    })

    let prev = '0'
    let lastSig = ''
    for (const cum of ['100000', '200000', '300000']) {
      const sig = funder.signChannelClaim(channelId, cum)
      const challenge = {
        id: `int-ch-${cum}-${Date.now()}`,
        realm: 'integration-test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        request: {
          amount: (BigInt(cum) - BigInt(prev)).toString(),
          channelId,
          recipient: receiver.address,
          methodDetails: { network: NETWORK, cumulativeAmount: prev },
        },
      }
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId, amount: cum, signature: sig },
        source: devnetSource(funder),
      })
      const receipt = await method.verify({
        credential: cred as any,
        request: challenge.request,
      })
      expect(receipt.status).toBe('success')
      prev = cum
      lastSig = sig
    }

    // Receiver closes the channel by redeeming the latest cumulative claim.
    const { txHash: closeTx } = await close({
      wallet: receiver,
      channelId,
      amount: prev,
      signature: lastSig,
      channelPublicKey: funder.publicKey,
      network: NETWORK,
      store,
    })
    expect(closeTx).toMatch(/^[0-9A-F]{64}$/)
  }, 360_000)
})
