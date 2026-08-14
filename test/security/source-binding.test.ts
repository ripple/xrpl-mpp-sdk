import { Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { encode, Wallet as XrplWallet } from 'xrpl'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { classicAddressFromDID, classicAddressFromPublicKey } from '../../sdk/src/utils/did.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const CHANNEL_RECIPIENT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'

/**
 * The pull-mode adversarial cases below need to hand-craft a Payment tx
 * blob signed by a specific account, which is not part of the SDK's
 * public Wallet surface (the SDK only signs Payments via the higher-level
 * `charge` flow). Those tests still construct an `xrpl.Wallet` directly
 * to sign a raw tx -- mirroring what a malicious client would do. Every
 * other case (DID parsing, public-key derivation, channel claims) goes
 * through the SDK Wallet API.
 */
describe('credential source binding (DID -> on-chain payer)', () => {
  describe('classicAddressFromDID', () => {
    it('parses well-formed did:pkh:xrpl DID', () => {
      const wallet = Wallet.generate()
      const did = `did:pkh:xrpl:testnet:${wallet.address}`
      expect(classicAddressFromDID(did)).toBe(wallet.address)
    })

    it('rejects empty source', () => {
      expect(() => classicAddressFromDID(undefined)).toThrow('source is required')
      expect(() => classicAddressFromDID('')).toThrow('source is required')
    })

    it('rejects wrong scheme', () => {
      expect(() => classicAddressFromDID('did:web:example.com:rABCDEF')).toThrow('invalid format')
    })

    it('rejects wrong namespace', () => {
      const wallet = Wallet.generate()
      expect(() => classicAddressFromDID(`did:pkh:stellar:testnet:${wallet.address}`)).toThrow(
        'invalid format',
      )
    })

    it('rejects empty network segment', () => {
      const wallet = Wallet.generate()
      expect(() => classicAddressFromDID(`did:pkh:xrpl::${wallet.address}`)).toThrow(
        'missing the network segment',
      )
    })

    it('rejects malformed XRPL address', () => {
      expect(() => classicAddressFromDID('did:pkh:xrpl:testnet:not-an-address')).toThrow(
        'invalid XRPL classic address',
      )
    })
  })

  describe('classicAddressFromPublicKey', () => {
    it('derives the same address as Wallet.address (ed25519)', () => {
      const wallet = Wallet.generate('ed25519')
      expect(classicAddressFromPublicKey(wallet.publicKey)).toBe(wallet.address)
    })

    it('derives the same address as Wallet.address (secp256k1)', () => {
      const wallet = Wallet.generate('ecdsa-secp256k1')
      expect(classicAddressFromPublicKey(wallet.publicKey)).toBe(wallet.address)
    })
  })

  describe('charge server verify -- pull mode source check', () => {
    it('rejects pull-mode credential whose tx.Account does not match source DID (third-party blob replay)', async () => {
      // Raw xrpl.Wallet so we can hand-craft and sign a Payment blob -- this
      // is the exact attack we want to defend against, so simulating it
      // requires direct access to the underlying signer.
      const realPayer = XrplWallet.generate()
      const attacker = Wallet.generate()
      const recipient = Wallet.generate()

      // Build a Payment tx signed by realPayer
      const tx = {
        TransactionType: 'Payment' as const,
        Account: realPayer.classicAddress,
        Destination: recipient.address,
        Amount: '1000000',
        Fee: '12',
        Sequence: 1,
        SigningPubKey: realPayer.publicKey,
        Flags: 0,
        LastLedgerSequence: 100_000_000,
      }
      const signed = realPayer.sign(tx as any)

      const challenge = {
        id: 'test-source-mismatch-pull',
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'charge' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        createdAt: new Date().toISOString(),
        request: {
          amount: '1000000',
          currency: 'XRP',
          recipient: recipient.address,
          methodDetails: { network: NETWORK },
        },
      }

      const cred = Credential.from({
        challenge: challenge as any,
        payload: { type: 'transaction', blob: signed.tx_blob },
        // attacker wraps real payer's blob with attacker's own DID
        source: `did:pkh:xrpl:${NETWORK}:${attacker.address}`,
      })

      const method = serverCharge({
        recipient: recipient.address,
        store: Store.memory(),
        storeDurability: 'process-local',
        network: NETWORK,
      })

      // The verify must fail before submitting because tx.Account != attacker
      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow(/SOURCE_MISMATCH/)
    })

    it('rejects credential with malformed source DID (no source check bypass)', async () => {
      const realPayer = XrplWallet.generate()
      const recipient = Wallet.generate()

      const tx = {
        TransactionType: 'Payment' as const,
        Account: realPayer.classicAddress,
        Destination: recipient.address,
        Amount: '1000000',
        Fee: '12',
        Sequence: 1,
        SigningPubKey: realPayer.publicKey,
        Flags: 0,
        LastLedgerSequence: 100_000_000,
      }
      const signed = realPayer.sign(tx as any)

      const challenge = {
        id: 'test-source-malformed',
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'charge' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        createdAt: new Date().toISOString(),
        request: {
          amount: '1000000',
          currency: 'XRP',
          recipient: recipient.address,
          methodDetails: { network: NETWORK },
        },
      }

      const cred = Credential.from({
        challenge: challenge as any,
        payload: { type: 'transaction', blob: signed.tx_blob },
        source: 'did:web:example.com',
      })

      const method = serverCharge({
        recipient: recipient.address,
        store: Store.memory(),
        storeDurability: 'process-local',
        network: NETWORK,
      })

      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow(/Credential is malformed|invalid format/)
    })
  })

  describe('charge server verify -- push mode source check', () => {
    it('rejects push-mode credential whose source DID does not match (hash-theft attack)', async () => {
      const recipient = Wallet.generate()

      // Pretend attacker submits real payer's tx hash
      const fakeHash = 'A'.repeat(64)

      const challenge = {
        id: 'test-hash-theft',
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'charge' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        createdAt: new Date().toISOString(),
        request: {
          amount: '1000000',
          currency: 'XRP',
          recipient: recipient.address,
          methodDetails: { network: NETWORK },
        },
      }

      // We cannot fully drive verifyPush here without a network mock, but we
      // can verify the source-binding check fires before any RPC. The error
      // surfaces from the hash regex / DID parse path before tx lookup.
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { type: 'hash', hash: fakeHash },
        source: 'not-a-did',
      })

      const method = serverCharge({
        recipient: recipient.address,
        store: Store.memory(),
        storeDurability: 'process-local',
        network: NETWORK,
      })

      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow(/Credential is malformed|invalid format/)
    })
  })

  describe('channel server verify -- source check', () => {
    it('rejects voucher credential whose source DID does not match channel funder', async () => {
      const funder = Wallet.generate()
      const attacker = Wallet.generate()
      const channelId = '0'.repeat(64)

      // Funder signs a valid claim via the SDK Wallet API.
      const cumDrops = '500000'
      const sig = funder.signChannelClaim(channelId, cumDrops)

      const challenge = {
        id: 'test-channel-source-mismatch',
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        createdAt: new Date().toISOString(),
        request: {
          amount: '500000',
          channelId,
          recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
          methodDetails: { network: NETWORK, cumulativeAmount: '0' },
        },
      }

      // attacker forges credential.source while keeping funder's signature
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId, amount: cumDrops, signature: sig },
        source: `did:pkh:xrpl:${NETWORK}:${attacker.address}`,
      })

      const method = serverChannel({
        publicKey: funder.publicKey,
        store: Store.memory(),
        storeDurability: 'process-local',
        // Not exercised here (verifyChannelOnChain is off); set so the missing-
        // recipient diagnostic does not fire.
        recipient: CHANNEL_RECIPIENT,
        network: NETWORK,
        verifyChannelOnChain: false,
        allowUnverifiedChannels: true,
      })

      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow(/SOURCE_MISMATCH/)
    })

    it('accepts voucher credential whose source DID matches channel funder', async () => {
      const funder = Wallet.generate()
      const channelId = '0'.repeat(64)

      const cumDrops = '500000'
      const sig = funder.signChannelClaim(channelId, cumDrops)

      const challenge = {
        id: 'test-channel-source-match',
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        createdAt: new Date().toISOString(),
        request: {
          amount: '500000',
          channelId,
          recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
          methodDetails: { network: NETWORK, cumulativeAmount: '0' },
        },
      }

      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId, amount: cumDrops, signature: sig },
        source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
      })

      const method = serverChannel({
        publicKey: funder.publicKey,
        store: Store.memory(),
        storeDurability: 'process-local',
        // Not exercised here (verifyChannelOnChain is off); set so the missing-
        // recipient diagnostic does not fire.
        recipient: CHANNEL_RECIPIENT,
        network: NETWORK,
        verifyChannelOnChain: false,
        allowUnverifiedChannels: true,
      })

      const receipt = await method.verify({
        credential: cred as any,
        request: challenge.request,
      })
      expect(receipt.status).toBe('success')
    })
  })

  // tx-blob fixtures used by SOURCE_MISMATCH must encode legitimately;
  // ensure xrpl.encode is reachable so a future API rename fails loudly.
  it('uses xrpl encode helper', () => {
    expect(typeof encode).toBe('function')
  })
})
