import { Challenge, Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel as channelMethod } from '../../sdk/src/channel/Methods.js'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { charge as chargeMethod } from '../../sdk/src/Methods.js'
import {
  assertCredentialHeaderSize,
  DEFAULT_MAX_CREDENTIAL_HEADER_BYTES,
} from '../../sdk/src/utils/limits.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const SECRET = 'l'.repeat(44)

describe('input limits', () => {
  describe('pre-parse header guard', () => {
    it('accepts an absent header', () => {
      expect(() => assertCredentialHeaderSize(undefined)).not.toThrow()
      expect(() => assertCredentialHeaderSize(null)).not.toThrow()
      expect(() => assertCredentialHeaderSize('')).not.toThrow()
    })

    it('accepts a realistic credential header', () => {
      const challenge = Challenge.from({
        realm: 'test',
        method: 'xrpl',
        intent: 'charge',
        secretKey: SECRET,
        expires: '2030-01-01T00:00:00.000Z',
        request: {
          amount: '1000000',
          currency: 'XRP',
          recipient: 'rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC',
        },
      } as never)
      const header = Credential.serialize(
        Credential.from({
          challenge,
          payload: { type: 'transaction', blob: 'AB'.repeat(400) } as never,
          source: `did:pkh:xrpl:${NETWORK}:rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC`,
        }),
      )
      expect(Buffer.byteLength(header)).toBeLessThan(DEFAULT_MAX_CREDENTIAL_HEADER_BYTES)
      expect(() => assertCredentialHeaderSize(header)).not.toThrow()
    })

    it('rejects an oversized header', () => {
      expect(() => assertCredentialHeaderSize('X'.repeat(1_000_000))).toThrow('over the')
    })

    it('counts bytes rather than characters', () => {
      // A multi-byte character would otherwise let a header sneak past a
      // character-count limit at roughly a third of its real size.
      const threeByteChar = '€' // euro sign, 3 bytes in UTF-8
      expect(() => assertCredentialHeaderSize(threeByteChar.repeat(40), 100)).toThrow('over the')
      expect(() => assertCredentialHeaderSize('a'.repeat(40), 100)).not.toThrow()
    })

    it('can be disabled with a zero limit', () => {
      expect(() => assertCredentialHeaderSize('X'.repeat(1_000_000), 0)).not.toThrow()
    })
  })

  describe('per-field bounds cap what an accepted credential can contain', () => {
    it('rejects an oversized transaction blob', () => {
      expect(
        chargeMethod.schema.credential.payload.safeParse({
          type: 'transaction',
          blob: 'A'.repeat(10_000_000),
        }).success,
      ).toBe(false)
    })

    it('rejects an oversized claim signature', () => {
      expect(
        channelMethod.schema.credential.payload.safeParse({
          action: 'voucher',
          channelId: 'A'.repeat(64),
          amount: '1',
          signature: 'A'.repeat(10_000_000),
        }).success,
      ).toBe(false)
    })

    it('rejects an oversized amount', () => {
      expect(
        channelMethod.schema.credential.payload.safeParse({
          action: 'voucher',
          channelId: 'A'.repeat(64),
          amount: '9'.repeat(10_000),
          signature: 'AB',
        }).success,
      ).toBe(false)
    })

    it('strips deep nesting rather than passing it through', () => {
      // Depth is not a live risk after the schema: strip mode discards
      // everything undeclared, so nothing nested reaches a decision. The cost of
      // the JSON.parse itself is upstream in mppx, which is why the meaningful
      // limit is the pre-parse header guard above.
      let deep: Record<string, unknown> = { type: 'hash', hash: 'AB'.repeat(32) }
      for (let i = 0; i < 2_000; i++) deep = { ...deep, nested: deep }

      const parsed = chargeMethod.schema.credential.payload.parse(deep)
      expect(Object.keys(parsed).sort()).toEqual(['hash', 'type'])
      expect(parsed).not.toHaveProperty('nested')
    })
  })

  describe('channel credential backstop', () => {
    it('rejects a credential over the channel cap', async () => {
      // The charge method had a size cap and this path had none, which was an
      // asymmetry rather than a decision.
      const funder = Wallet.generate()
      const recipient = Wallet.generate()
      const channelId = 'A'.repeat(64)

      const method = serverChannel({
        publicKey: funder.publicKey,
        recipient: recipient.address,
        network: NETWORK,
        store: Store.memory(),
        storeDurability: 'process-local',
        verifyChannelOnChain: false,
        allowUnverifiedChannels: true,
        maxCredentialSize: 256,
      })

      const challenge = {
        id: 'ch-oversized',
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        request: {
          amount: '100000',
          channelId,
          recipient: recipient.address,
          methodDetails: { network: NETWORK, cumulativeAmount: '0' },
        },
      }
      const cred = Credential.from({
        challenge: challenge as never,
        payload: {
          action: 'voucher',
          channelId,
          amount: '100000',
          signature: funder.signChannelClaim(channelId, '100000'),
        } as never,
        source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
      })

      await expect(
        method.verify({ credential: cred as never, request: challenge.request as never }),
      ).rejects.toThrow(/Credential too large/)
    })
  })
})
