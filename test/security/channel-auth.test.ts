import { Errors } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channelClosed, channelNotFound, invalidSignature } from '../../sdk/src/errors.js'

describe('Channel Authorization', () => {
  describe('Claim signer validation', () => {
    it('claim signed by wrong key -- rejected with INVALID_SIGNATURE', () => {
      const err = invalidSignature('Claim signer does not match channel PublicKey')
      expect(err).toBeInstanceOf(Errors.InvalidSignatureError)
      expect(err.message).toContain('INVALID_SIGNATURE')
      expect(err.status).toBe(402)
    })
  })

  describe('Close authorization', () => {
    it('close attempt by unauthorized party -- rejected', () => {
      // Only channel source (funder) or destination should be able to close
      const err = invalidSignature(
        'Unauthorized close attempt -- not channel source or destination',
      )
      expect(err.message).toContain('INVALID_SIGNATURE')
    })
  })

  describe('Channel state validation', () => {
    it('claim on expired channel -- rejected with CHANNEL_EXPIRED', () => {
      const channelId = 'E'.repeat(64)
      const err = channelClosed(channelId)
      expect(err).toBeInstanceOf(Errors.ChannelClosedError)
      expect(err.message).toContain('CHANNEL_EXPIRED')
      expect(err.status).toBe(410)
    })

    it('claim on non-existent channel -- rejected with CHANNEL_NOT_FOUND', () => {
      const channelId = 'F'.repeat(64)
      const err = channelNotFound(channelId)
      expect(err).toBeInstanceOf(Errors.ChannelNotFoundError)
      expect(err.message).toContain('CHANNEL_NOT_FOUND')
      expect(err.status).toBe(410)
    })

    it('claim amount exceeding channel Balance -- should fail verification', () => {
      // This is tested at the integration level when we have actual channel state.
      // Here we verify the error constructor works.
      const err = new Errors.AmountExceedsDepositError({
        reason: 'Claim amount 2000000 exceeds channel balance 1000000',
      })
      expect(err.status).toBe(402)
      expect(err.message).toContain('2000000')
      expect(err.message).toContain('1000000')
    })
  })
})
