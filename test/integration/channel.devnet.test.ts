import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { channel as clientChannel, openChannel } from '../../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import type { XrplReceiptFields } from '../../sdk/src/types.js'
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
      network: NETWORK,
      store,
      storeDurability: 'process-local',
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
  /**
   * The point of not configuring `publicKey`: one server, several funders it
   * had never heard of, and one of them signing with a key pair dedicated to
   * the channel rather than with its account key. Both are ordinary on the
   * ledger and both used to be refused.
   */
  it('accepts channels from two unrelated funders with no key configured', async () => {
    const [second, channelKey] = await Promise.all([createFundedWallet(), createFundedWallet()])

    const [first, dedicated] = await Promise.all([
      openChannel({
        wallet: funder,
        destination: receiver.address,
        amount: '3000000',
        settleDelay: 3600,
        network: NETWORK,
      }),
      // Funded by `second`, but the channel names a different key, which is
      // what the ledger documentation recommends.
      openChannel({
        wallet: second,
        destination: receiver.address,
        amount: '3000000',
        settleDelay: 3600,
        publicKey: channelKey.publicKey,
        network: NETWORK,
      }),
    ])

    const method = serverChannel({
      // No publicKey: the key comes from each channel's on-ledger PublicKey.
      recipient: receiver.address,
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
    })

    async function payOnce(params: {
      channelId: string
      signer: Wallet
      sender: Wallet
      cumulative: string
    }) {
      const { channelId, signer, sender, cumulative } = params
      const signature = signer.signChannelClaim(channelId, cumulative)
      const challenge = {
        id: `int-multi-${channelId.slice(0, 8)}-${Date.now()}`,
        realm: 'integration-test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        request: {
          amount: cumulative,
          channelId,
          recipient: receiver.address,
          methodDetails: { network: NETWORK, cumulativeAmount: '0' },
        },
      }
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId, amount: cumulative, signature },
        source: devnetSource(sender),
      })
      return await method.verify({ credential: cred as any, request: challenge.request })
    }

    const one = await payOnce({
      channelId: first.channelId,
      signer: funder,
      sender: funder,
      cumulative: '120000',
    })
    expect(one.status).toBe('success')

    const two = await payOnce({
      channelId: dedicated.channelId,
      signer: channelKey,
      sender: second,
      cumulative: '340000',
    })
    expect(two.status).toBe('success')
  }, 360_000)
  /**
   * The whole open flow with nothing learned out of band: the server states
   * the recipient in its challenge, the client builds the PaymentChannelCreate
   * from it, and the server broadcasts it and reads back the channel id. No
   * /info, no /register, no address configured on the client.
   */
  it('opens a channel from the challenge alone, then pays over it', async () => {
    const payer = await createFundedWallet()
    const store = Store.memory()

    const server = serverChannel({
      recipient: receiver.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })
    const client = clientChannel({
      wallet: payer,
      network: NETWORK,
      // Terms are ours; the destination comes from the challenge.
      openChannel: { amount: '4000000', settleDelay: 3600 },
    })

    const openChallengeObj = {
      id: `int-open-${payer.address.slice(1, 9)}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '0',
        channelId: '',
        recipient: receiver.address,
        methodDetails: { network: NETWORK },
      },
    }

    const openBlob = await client.createCredential({
      challenge: openChallengeObj as any,
      context: { action: 'open' },
    })
    const openReceipt = await server.verify({
      credential: Credential.deserialize(openBlob) as any,
      request: openChallengeObj.request,
    })
    expect(openReceipt.status).toBe('success')

    // Named fields, not a split of `reference`. `reference` keeps its old
    // composite value, and is asserted here so it stays a compatible shape.
    const openFields = openReceipt as typeof openReceipt & XrplReceiptFields
    const { channelId } = openFields
    // `expect` does not narrow, and the field is optional because a voucher
    // receipt has no channel to report.
    if (!channelId) throw new Error('open receipt carried no channelId')
    expect(channelId).toMatch(/^[0-9A-F]{64}$/)
    expect(openFields.txHash).toMatch(/^[0-9A-F]{64}$/)
    expect(openReceipt.reference).toBe(`open:${channelId}:${openFields.txHash}`)

    // Then an ordinary voucher over the channel the server just learned about.
    const voucherChallenge = {
      ...openChallengeObj,
      id: `${openChallengeObj.id}-v1`,
      request: {
        ...openChallengeObj.request,
        amount: '150000',
        channelId,
        methodDetails: { network: NETWORK, cumulativeAmount: '0' },
      },
    }
    const voucherBlob = await client.createCredential({
      challenge: voucherChallenge as any,
      context: {},
    })
    const voucherReceipt = await server.verify({
      credential: Credential.deserialize(voucherBlob) as any,
      request: voucherChallenge.request,
    })
    expect(voucherReceipt.status).toBe('success')
  }, 360_000)
})
