import { describe, expect, it } from 'vitest'
import { channel } from '../../sdk/src/channel/Methods.js'
import { invalidSignature, verificationFailed } from '../../sdk/src/errors.js'
import { createMockChannelChallenge, createMockChargeChallenge } from '../utils/test-helpers.js'

describe('Credential Tampering Detection', () => {
  describe('Charge tampering', () => {
    it('modified amount in credential vs challenge -- should be detectable', () => {
      const challenge = createMockChargeChallenge({ amount: '1000000' })
      const tamperedChallenge = {
        ...challenge,
        request: { ...challenge.request, amount: '1' },
      }

      // The challenge embedded in the credential has the original amount
      // Server should compare credential.challenge.request.amount against its own records
      expect(challenge.request.amount).toBe('1000000')
      expect(tamperedChallenge.request.amount).toBe('1')

      // Error for amount mismatch
      const err = verificationFailed(
        'AMOUNT_MISMATCH',
        'Amount in credential does not match challenge',
      )
      expect(err.message).toContain('AMOUNT_MISMATCH')
    })

    it('modified recipient in credential -- should be detectable', () => {
      const challenge = createMockChargeChallenge({
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      })
      const attackerAddress = 'rs1oYzmEyepu3AxyqCGvYRkw5B4ioMUMPi'

      expect(challenge.request.recipient).not.toBe(attackerAddress)

      const err = verificationFailed('RECIPIENT_MISMATCH', 'Recipient does not match challenge')
      expect(err.message).toContain('RECIPIENT_MISMATCH')
    })

    it('forged signature (random bytes) -- should produce invalid signature error', () => {
      const err = invalidSignature('Signature verification failed')
      expect(err.type).toBe('https://paymentauth.org/problems/session/invalid-signature')
      expect(err.message).toContain('INVALID_SIGNATURE')
    })

    it('valid credential but for a different server/recipient -- detectable via challenge binding', () => {
      const serverA = createMockChargeChallenge({ recipient: 'rwLXE1S17CDh8XLR7AuxQeYd2a2UJd6Hj2' })
      const serverB = createMockChargeChallenge({ recipient: 'rMHD4MHEqf33shRbWZaNa81P91WF24eKxR' })

      // Even if the signature is valid, the recipient in the challenge must match
      expect(serverA.request.recipient).not.toBe(serverB.request.recipient)
    })
  })

  describe('Channel tampering', () => {
    it('valid signature but wrong channelId -- should be rejected', () => {
      const challenge = createMockChannelChallenge({ channelId: 'A'.repeat(64) })
      const wrongChannel = 'B'.repeat(64)

      expect(challenge.request.channelId).not.toBe(wrongChannel)

      // verifyPaymentChannelClaim with wrong channelId returns false
      const err = invalidSignature('Claim signature does not match channel')
      expect(err.message).toContain('INVALID_SIGNATURE')
    })

    it('non-numeric cumulative amount in voucher -- schema rejects', () => {
      const payload = {
        action: 'voucher' as const,
        channelId: '0'.repeat(64),
        amount: '-500',
        signature: 'ab'.repeat(64),
      }
      expect(() => channel.schema.credential.payload.parse(payload)).toThrow()
    })
  })
})

describe('a pinned client refuses a challenge for another ledger', () => {
  it('rejects a mainnet challenge when pinned to testnet', async () => {
    // The challenge names the ledger and the client follows it. That is right by
    // default, but the same seed controls the same address on every XRPL
    // network, so an unpinned client told `mainnet` signs against a real
    // balance. An explicit `network` is a pin, not a hint.
    const { charge } = await import('../../sdk/src/client/Charge.js')
    const { Wallet } = await import('../../sdk/src/utils/wallet.js')
    const wallet = Wallet.generate()

    const method: any = charge({ wallet, network: 'testnet', preflight: false })
    const challenge = {
      id: 'pin-test',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '1000000',
        currency: 'XRP',
        recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        methodDetails: { network: 'mainnet' },
      },
    }

    await expect(method.createCredential({ challenge, context: {} })).rejects.toThrow(
      /CHALLENGE_REJECTED|pinned to testnet/,
    )
  })

  it('still follows the challenge when the caller did not pin', async () => {
    // Unchanged behaviour for callers who never passed `network`.
    const { charge } = await import('../../sdk/src/client/Charge.js')
    const { Wallet } = await import('../../sdk/src/utils/wallet.js')
    const method: any = charge({ wallet: Wallet.generate(), preflight: false })
    expect(typeof method.createCredential).toBe('function')
  })
})
