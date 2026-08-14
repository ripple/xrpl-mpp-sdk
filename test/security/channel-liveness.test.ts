import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PayChannelLedgerEntry,
  channel as serverChannel,
} from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const CHANNEL_ID = 'C'.repeat(64)
const RIPPLE_EPOCH = 946_684_800

/** Ripple-epoch seconds for a moment `ms` from now. */
function rippleTimeIn(ms: number): number {
  return Math.floor((Date.now() + ms) / 1000) - RIPPLE_EPOCH
}

/**
 * A voucher is a claim, not settled funds: redemption needs the channel to stay
 * open, funded, and long enough from closing that a PaymentChannelClaim can be
 * submitted and validated. These cover the five liveness gaps.
 */
describe('channel liveness', () => {
  let funder: Wallet
  let recipient: Wallet
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    funder = Wallet.generate()
    recipient = Wallet.generate()
    store = Store.memory()
  })

  function entry(overrides: Partial<PayChannelLedgerEntry> = {}): PayChannelLedgerEntry {
    return {
      Account: funder.address,
      Destination: recipient.address,
      Amount: '10000000',
      Balance: '0',
      PublicKey: funder.publicKey,
      SettleDelay: 3600,
      Expiration: null,
      CancelAfter: null,
      ...overrides,
    }
  }

  function method(lookup: any, overrides: Record<string, unknown> = {}) {
    return serverChannel({
      publicKey: funder.publicKey,
      recipient: recipient.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
      ...overrides,
    })
  }

  /**
   * `request.amount` is the *incremental* price of this request, while the
   * payload carries the absolute cumulative, so the two differ once a channel
   * has history.
   */
  function voucher(cumulative: string, previousCumulative = '0') {
    const signature = funder.signChannelClaim(CHANNEL_ID, cumulative)
    const delta = (BigInt(cumulative) - BigInt(previousCumulative)).toString()
    const challenge = {
      id: `ch-${cumulative}-${Math.random()}`,
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: delta,
        channelId: CHANNEL_ID,
        recipient: recipient.address,
        methodDetails: { network: NETWORK, cumulativeAmount: previousCumulative },
      },
    }
    const cred = Credential.from({
      challenge: challenge as any,
      payload: { action: 'voucher', channelId: CHANNEL_ID, amount: cumulative, signature },
      source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
    })
    return { challenge, cred }
  }

  const verify = (m: ReturnType<typeof method>, v: ReturnType<typeof voucher>) =>
    m.verify({ credential: v.cred as any, request: v.challenge.request })

  describe('settle delay', () => {
    it('rejects a channel whose SettleDelay is below the minimum', async () => {
      // A short delay lets the funder close and reclaim unredeemed value faster
      // than the sweeper can notice and submit a claim.
      const lookup = vi.fn(async () => entry({ SettleDelay: 10 }))
      await expect(verify(method(lookup), voucher('100000'))).rejects.toThrow(
        /CHANNEL_SETTLE_DELAY_TOO_SHORT/,
      )
    })

    it('accepts a channel at the configured minimum', async () => {
      const lookup = vi.fn(async () => entry({ SettleDelay: 120 }))
      const result = await verify(method(lookup, { minSettleDelay: 120 }), voucher('100000'))
      expect(result.status).toBe('success')
    })

    it('skips the check when disabled', async () => {
      const lookup = vi.fn(async () => entry({ SettleDelay: 1 }))
      const result = await verify(method(lookup, { minSettleDelay: 0 }), voucher('100000'))
      expect(result.status).toBe('success')
    })

    it('tolerates a lookup that omits SettleDelay', async () => {
      // Custom channelLookup implementations may not surface it, and the
      // destination and funding checks still apply.
      const { SettleDelay: _omitted, ...withoutDelay } = entry()
      const lookup = vi.fn(async () => withoutDelay as PayChannelLedgerEntry)
      const result = await verify(method(lookup), voucher('100000'))
      expect(result.status).toBe('success')
    })
  })

  describe('closing window', () => {
    it('rejects a voucher inside the settlement margin before Expiration', async () => {
      // Inside this margin there is no time left to submit and validate a
      // claim, so the value would be earned and unredeemable.
      const lookup = vi.fn(async () => entry({ Expiration: rippleTimeIn(20_000) }))
      await expect(verify(method(lookup), voucher('100000'))).rejects.toThrow(/CHANNEL_CLOSING/)
    })

    it('rejects a voucher inside the margin before CancelAfter', async () => {
      // CancelAfter is enforced, not merely reported: once it passes, anyone
      // can delete the channel.
      const lookup = vi.fn(async () => entry({ CancelAfter: rippleTimeIn(20_000) }))
      await expect(verify(method(lookup), voucher('100000'))).rejects.toThrow(/CHANNEL_CLOSING/)
    })

    it('rejects once CancelAfter has passed', async () => {
      const lookup = vi.fn(async () => entry({ CancelAfter: rippleTimeIn(-60_000) }))
      await expect(verify(method(lookup), voucher('100000'))).rejects.toThrow(/CHANNEL_EXPIRED/)
    })

    it('accepts a voucher comfortably before the deadline', async () => {
      const lookup = vi.fn(async () => entry({ CancelAfter: rippleTimeIn(3_600_000) }))
      const result = await verify(method(lookup), voucher('100000'))
      expect(result.status).toBe('success')
    })

    it('still fires onDisputeDetected when CancelAfter is set but distant', async () => {
      const onDisputeDetected = vi.fn()
      const lookup = vi.fn(async () => entry({ CancelAfter: rippleTimeIn(3_600_000) }))
      await verify(method(lookup, { onDisputeDetected }), voucher('100000'))
      expect(onDisputeDetected).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: CHANNEL_ID }),
      )
    })
  })

  describe('metadata cache', () => {
    it('caps the cache lifetime by how long the channel has left', async () => {
      // The flat TTL let a closing channel be honoured for the rest of the
      // window, because the forced refresh only triggered on the balance
      // condition. The effective TTL now shrinks to a third of the remaining
      // window, so the last look before a close is always fresh.
      //
      // 3s to the deadline caps a 10-minute configured TTL at ~1s, so a voucher
      // 1.2s later must re-read rather than trust the snapshot.
      const lookup = vi.fn(async () => entry({ CancelAfter: rippleTimeIn(3_000) }))
      const m = method(lookup, { channelMetadataTtlMs: 600_000, settlementMarginMs: 0 })

      await verify(m, voucher('100000'))
      expect(lookup).toHaveBeenCalledTimes(1)

      await new Promise((r) => setTimeout(r, 1_200))
      await verify(m, voucher('200000', '100000'))
      expect(lookup).toHaveBeenCalledTimes(2)
    })

    it('still caches when the channel has no deadline', async () => {
      const lookup = vi.fn(async () => entry())
      const m = method(lookup, { channelMetadataTtlMs: 600_000 })

      await verify(m, voucher('100000'))
      await verify(m, voucher('200000', '100000'))

      expect(lookup).toHaveBeenCalledTimes(1)
    })
  })

  describe('unverified channels', () => {
    it('refuses to construct with verification off and no acknowledgement', () => {
      expect(() =>
        serverChannel({
          publicKey: funder.publicKey,
          recipient: recipient.address,
          network: NETWORK,
          store,
          storeDurability: 'process-local',
          verifyChannelOnChain: false,
        }),
      ).toThrow(/allowUnverifiedChannels/)
    })

    it('constructs once the risk is acknowledged', () => {
      expect(() =>
        serverChannel({
          publicKey: funder.publicKey,
          recipient: recipient.address,
          network: NETWORK,
          store,
          storeDurability: 'process-local',
          verifyChannelOnChain: false,
          allowUnverifiedChannels: true,
        }),
      ).not.toThrow()
    })
  })

  describe('exposure reporting', () => {
    it('reports remaining redeemable value and close time', async () => {
      const onVoucherAccepted = vi.fn()
      const closesAt = rippleTimeIn(3_600_000)
      const lookup = vi.fn(async () => entry({ CancelAfter: closesAt }))

      await verify(method(lookup, { onVoucherAccepted }), voucher('2500000'))

      expect(onVoucherAccepted).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: CHANNEL_ID,
          cumulative: '2500000',
          fundedDrops: '10000000',
          // 10 XRP funded, 2.5 credited, so 7.5 still redeemable.
          remainingDrops: '7500000',
        }),
      )
      expect(onVoucherAccepted.mock.calls[0][0].closesAt).toBeTypeOf('string')
    })
  })
})
