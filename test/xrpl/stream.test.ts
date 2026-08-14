import { describe, expect, it } from 'vitest'
import { dropsToXrp, verifyPaymentChannelClaim } from 'xrpl'
import { ChannelSession, ChannelStream } from '../../sdk/src/channel/stream.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const CHANNEL_ID = '0'.repeat(64)

/**
 * `verifyPaymentChannelClaim` is the only piece of `xrpl.js` we still
 * import here -- it's the on-the-wire signature checker that any server
 * (including ours) ultimately runs to validate the claim. Asserting
 * against it directly proves that the claims our high-level streaming
 * primitives sign are consumable by a vanilla XRPL verifier.
 */
describe('ChannelStream', () => {
  it('signs a claim every tick when granularity = 1', () => {
    const wallet = Wallet.generate()
    const stream = new ChannelStream({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerUnit: '100',
      granularity: 1,
    })

    const claim1 = stream.tick(1)
    expect(claim1).not.toBeNull()
    expect(claim1!.amount).toBe('100')

    const claim2 = stream.tick(1)
    expect(claim2).not.toBeNull()
    expect(claim2!.amount).toBe('200')
  })

  it('only signs after granularity boundary is crossed', () => {
    const wallet = Wallet.generate()
    const stream = new ChannelStream({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerUnit: '100',
      granularity: 5,
    })

    // Initial tick signs (lastSignedCumulative = 0)
    const c0 = stream.tick(1)
    expect(c0).not.toBeNull()

    // Subsequent ticks under 5 do not produce new signatures
    expect(stream.tick(1)).toBeNull()
    expect(stream.tick(1)).toBeNull()
    expect(stream.tick(1)).toBeNull()

    // Crossing the 5th unit produces a new signature
    const c5 = stream.tick(1)
    expect(c5).not.toBeNull()
    expect(c5!.amount).toBe('500')
  })

  it('produces signatures verifiable by the funder public key', () => {
    const wallet = Wallet.generate()
    const stream = new ChannelStream({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerUnit: '1000',
    })
    const claim = stream.tick(3)
    expect(claim).not.toBeNull()
    expect(
      verifyPaymentChannelClaim(
        CHANNEL_ID,
        dropsToXrp(claim!.amount).toString(),
        claim!.signature,
        wallet.publicKey,
      ),
    ).toBe(true)
  })

  it('latest() returns the most recent signed claim', () => {
    const wallet = Wallet.generate()
    const stream = new ChannelStream({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerUnit: '100',
    })
    expect(stream.latest()).toBeNull()
    stream.tick(2)
    expect(stream.latest()?.amount).toBe('200')
    stream.tick(3)
    expect(stream.latest()?.amount).toBe('500')
  })

  it('exposes total units consumed and current amount', () => {
    const wallet = Wallet.generate()
    const stream = new ChannelStream({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerUnit: '100',
    })
    stream.tick(7)
    expect(stream.totalUnits).toBe('7')
    expect(stream.currentAmount).toBe('700')
  })

  it('still accepts a raw privateKey for backward compatibility', () => {
    const wallet = Wallet.generate()
    const stream = new ChannelStream({
      channelId: CHANNEL_ID,
      privateKey: wallet.privateKey,
      dropsPerUnit: '100',
    })
    const claim = stream.tick(1)
    expect(claim).not.toBeNull()
    expect(
      verifyPaymentChannelClaim(
        CHANNEL_ID,
        dropsToXrp(claim!.amount).toString(),
        claim!.signature,
        wallet.publicKey,
      ),
    ).toBe(true)
  })

  it('rejects construction without wallet or privateKey', () => {
    expect(
      () =>
        new ChannelStream({
          channelId: CHANNEL_ID,
          dropsPerUnit: '100',
        } as any),
    ).toThrow(/require a wallet or privateKey/)
  })
})

describe('ChannelSession', () => {
  it('signs a claim per paid request when granularity = 1', () => {
    const wallet = Wallet.generate()
    const session = new ChannelSession({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerRequest: '500',
      granularity: 1,
    })

    const claim1 = session.pay()
    expect(claim1).not.toBeNull()
    expect(claim1!.amount).toBe('500')

    const claim2 = session.pay()
    expect(claim2!.amount).toBe('1000')

    expect(session.requests).toBe(2)
  })

  it('settle() force-signs the current cumulative even mid-bucket', () => {
    const wallet = Wallet.generate()
    const session = new ChannelSession({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerRequest: '100',
      granularity: 10,
    })
    session.pay()
    session.pay()
    session.pay()
    const settled = session.settle()
    expect(settled.amount).toBe('300')
  })

  it('latest() reflects the most recent signed claim', () => {
    const wallet = Wallet.generate()
    const session = new ChannelSession({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerRequest: '100',
    })
    expect(session.latest()).toBeNull()
    session.pay()
    expect(session.latest()?.amount).toBe('100')
  })

  it('produces signatures verifiable by the funder public key', () => {
    const wallet = Wallet.generate()
    const session = new ChannelSession({
      channelId: CHANNEL_ID,
      wallet,
      dropsPerRequest: '500',
    })
    const claim = session.pay()
    expect(claim).not.toBeNull()
    expect(
      verifyPaymentChannelClaim(
        CHANNEL_ID,
        dropsToXrp(claim!.amount).toString(),
        claim!.signature,
        wallet.publicKey,
      ),
    ).toBe(true)
  })
})
