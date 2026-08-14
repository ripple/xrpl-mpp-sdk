import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PayChannelLedgerEntry,
  channel as serverChannel,
} from '../../sdk/src/channel/server/Channel.js'
import { storeKeys } from '../../sdk/src/utils/keys.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHANNEL_ID = 'D'.repeat(64)
const TX_HASH = 'E'.repeat(64)

/**
 * A channelId and a transaction hash derive purely from transaction content,
 * and mainnet, testnet and devnet carry no NetworkID field. A wallet built from
 * one seed therefore has the same account and sequence space on every network,
 * so the same account paying the same destination the same amount at the same
 * sequence yields an identical channelId and an identical hash on testnet and
 * on mainnet. Only the key namespace keeps their replay state apart.
 */
describe('store key namespacing', () => {
  describe('storeKeys', () => {
    it('includes the network in every key', () => {
      const keys = storeKeys('mainnet')
      expect(keys.challenge('abc')).toBe('xrpl:mainnet:challenge:abc')
      expect(keys.tx(TX_HASH)).toBe(`xrpl:mainnet:tx:${TX_HASH}`)
      expect(keys.channel(CHANNEL_ID)).toBe(`xrpl:mainnet:channel:${CHANNEL_ID}`)
      expect(keys.channelMeta(CHANNEL_ID)).toBe(`xrpl:mainnet:channel-meta:${CHANNEL_ID}`)
      expect(keys.channelFinalized(CHANNEL_ID)).toBe(`xrpl:mainnet:channel-finalized:${CHANNEL_ID}`)
      expect(keys.channelRedeemed(CHANNEL_ID)).toBe(`xrpl:mainnet:channel-redeemed:${CHANNEL_ID}`)
    })

    it('never produces the same key for two networks', () => {
      const networks = ['mainnet', 'testnet', 'devnet'] as const
      const builders = [
        'challenge',
        'tx',
        'channel',
        'channelMeta',
        'channelFinalized',
        'channelRedeemed',
      ] as const

      for (const builder of builders) {
        const produced = networks.map((network) => storeKeys(network)[builder](CHANNEL_ID))
        expect(new Set(produced).size).toBe(networks.length)
      }
    })

    it('keeps every key family distinct within one network', () => {
      const keys = storeKeys('testnet')
      const all = [
        keys.challenge(CHANNEL_ID),
        keys.tx(CHANNEL_ID),
        keys.channel(CHANNEL_ID),
        keys.channelMeta(CHANNEL_ID),
        keys.channelFinalized(CHANNEL_ID),
        keys.channelRedeemed(CHANNEL_ID),
      ]
      expect(new Set(all).size).toBe(all.length)
    })

    it('cannot steer one family onto another whatever the id contains', () => {
      // Each family name is a single segment, so this holds without relying on
      // the 64-hex channelId constraint enforced at the schema boundary.
      const keys = storeKeys('testnet')
      for (const hostile of ['meta:x', ':meta:x', '-meta:x', 'finalized:x', 'redeemed:x']) {
        expect(keys.channel(hostile)).not.toBe(keys.channelMeta('x'))
        expect(keys.channel(hostile)).not.toBe(keys.channelFinalized('x'))
        expect(keys.channel(hostile)).not.toBe(keys.channelRedeemed('x'))
      }
    })
  })

  describe('two networks sharing one store', () => {
    let funder: Wallet
    let recipient: Wallet
    let store: ReturnType<typeof Store.memory>

    beforeEach(() => {
      funder = Wallet.generate()
      recipient = Wallet.generate()
      store = Store.memory()
    })

    function entry(): PayChannelLedgerEntry {
      return {
        Account: funder.address,
        Destination: recipient.address,
        Amount: '10000000',
        Balance: '0',
        PublicKey: funder.publicKey,
        SettleDelay: 3600,
        Expiration: null,
        CancelAfter: null,
      }
    }

    function method(network: 'testnet' | 'devnet') {
      return serverChannel({
        publicKey: funder.publicKey,
        recipient: recipient.address,
        network,
        store,
        storeDurability: 'process-local',
        verifyChannelOnChain: true,
        channelLookup: vi.fn(async () => entry()),
      })
    }

    function voucher(cumulative: string, network: string) {
      const signature = funder.signChannelClaim(CHANNEL_ID, cumulative)
      const challenge = {
        id: `ch-${network}-${cumulative}-${Math.random()}`,
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        createdAt: new Date().toISOString(),
        request: {
          amount: cumulative,
          channelId: CHANNEL_ID,
          recipient: recipient.address,
          methodDetails: { network, cumulativeAmount: '0' },
        },
      }
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId: CHANNEL_ID, amount: cumulative, signature },
        source: `did:pkh:xrpl:${network}:${funder.address}`,
      })
      return { challenge, cred }
    }

    it('keeps channel high-water marks independent across networks', async () => {
      // Same channelId on both, which is reachable in reality for a
      // seed-identical funder. Advancing one must not advance the other.
      const a = voucher('500000', 'testnet')
      await method('testnet').verify({ credential: a.cred as any, request: a.challenge.request })

      const b = voucher('100000', 'devnet')
      const result = await method('devnet').verify({
        credential: b.cred as any,
        request: b.challenge.request,
      })

      // On devnet this is the first voucher, so a lower cumulative is fine.
      // Sharing a namespace would have rejected it as a regression.
      expect(result.status).toBe('success')

      expect(await store.get(storeKeys('testnet').channel(CHANNEL_ID))).toMatchObject({
        cumulative: '500000',
      })
      expect(await store.get(storeKeys('devnet').channel(CHANNEL_ID))).toMatchObject({
        cumulative: '100000',
      })
    })

    it('does not let one network finalize another network channel', async () => {
      await store.put(storeKeys('testnet').channelFinalized(CHANNEL_ID), {
        reason: 'closed',
        timestamp: Date.now(),
      })

      // Rejected on testnet, where the tombstone lives.
      const a = voucher('500000', 'testnet')
      await expect(
        method('testnet').verify({ credential: a.cred as any, request: a.challenge.request }),
      ).rejects.toThrow(/CHANNEL_EXPIRED/)

      // Unaffected on devnet.
      const b = voucher('500000', 'devnet')
      const result = await method('devnet').verify({
        credential: b.cred as any,
        request: b.challenge.request,
      })
      expect(result.status).toBe('success')
    })

    it('keeps challenge single-use markers per network', async () => {
      const keys = { testnet: storeKeys('testnet'), devnet: storeKeys('devnet') }
      await store.put(keys.testnet.challenge('shared-id'), { usedAt: 'now' })

      expect(await store.get(keys.testnet.challenge('shared-id'))).not.toBeNull()
      expect(await store.get(keys.devnet.challenge('shared-id'))).toBeNull()
    })

    it('keeps transaction hash markers per network', async () => {
      // The realistic case: identical tx content signed by a seed-identical
      // wallet produces the same hash on both networks.
      const keys = { testnet: storeKeys('testnet'), mainnet: storeKeys('mainnet') }
      await store.put(keys.testnet.tx(TX_HASH), { status: 'confirmed' })

      expect(await store.get(keys.testnet.tx(TX_HASH))).not.toBeNull()
      expect(await store.get(keys.mainnet.tx(TX_HASH))).toBeNull()
    })
  })
})
