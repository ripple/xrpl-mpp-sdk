import { Mppx, Store } from 'mppx/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const SECRET = 'a'.repeat(32)

/**
 * A challenge id is an HMAC over the challenge's own fields -- realm, method,
 * intent, the serialised request, `expires`, `digest`, `opaque` -- and there is
 * no nonce in that input. Two challenges with identical content therefore get
 * an identical id, by construction.
 *
 * That matters because the id is the single-use replay key. Two challenges
 * sharing one means the second payment is refused as already answered: a payer
 * is charged nothing and served nothing.
 *
 * What keeps them apart is the `reference` this SDK puts in `methodDetails`,
 * one fresh `crypto.randomUUID()` per challenge. `expires` also varies at
 * millisecond granularity and masks the problem in ordinary use, which is
 * exactly why this needs a test: with the clock frozen, removing the reference
 * produces the same id twice, and nothing else notices.
 */
function idOf(result: unknown): string {
  const header =
    ((result as { challenge: Response }).challenge as Response).headers.get('WWW-Authenticate') ??
    ''
  return header.match(/id="([^"]+)"/)?.[1] ?? ''
}

describe('challenge ids are unique per challenge', () => {
  beforeEach(() => {
    // Frozen, so `expires` is identical across challenges and cannot stand in
    // for the nonce. This is the condition the property has to hold under.
    vi.useFakeTimers({ now: new Date('2026-09-07T12:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('charge: two identical requests get different ids on a frozen clock', async () => {
    const recipient = Wallet.generate()
    const mppx = Mppx.create({
      secretKey: SECRET,
      methods: [
        serverCharge({
          recipient: recipient.address,
          network: 'testnet',
          store: Store.memory(),
          storeDurability: 'process-local',
        }),
      ],
    })
    const handler = mppx['xrpl/charge']({
      amount: '1000000',
      currency: 'XRP',
      recipient: recipient.address,
    })

    const ids = [
      idOf(await handler(new Request('http://example.test/r'))),
      idOf(await handler(new Request('http://example.test/r'))),
    ]

    expect(ids[0]).not.toBe('')
    expect(new Set(ids).size).toBe(2)
  })

  it('session: two identical requests get different ids on a frozen clock', async () => {
    const recipient = Wallet.generate()
    const mppx = Mppx.create({
      secretKey: SECRET,
      methods: [
        serverChannel({
          recipient: recipient.address,
          network: 'testnet',
          store: Store.memory(),
          storeDurability: 'process-local',
        }),
      ],
    })
    const handler = mppx['xrpl/session']({
      amount: '100000',
      channelId: '',
      recipient: recipient.address,
    })

    const ids = [
      idOf(await handler(new Request('http://example.test/r'))),
      idOf(await handler(new Request('http://example.test/r'))),
    ]

    expect(ids[0]).not.toBe('')
    expect(new Set(ids).size).toBe(2)
  })

  it('charge: stays unique across a burst issued in one tick', async () => {
    const recipient = Wallet.generate()
    const mppx = Mppx.create({
      secretKey: SECRET,
      methods: [
        serverCharge({
          recipient: recipient.address,
          network: 'testnet',
          store: Store.memory(),
          storeDurability: 'process-local',
        }),
      ],
    })
    const handler = mppx['xrpl/charge']({
      amount: '1000000',
      currency: 'XRP',
      recipient: recipient.address,
    })

    const results = await Promise.all(
      Array.from({ length: 25 }, () => handler(new Request('http://example.test/r'))),
    )

    expect(new Set(results.map(idOf)).size).toBe(25)
  })
})
