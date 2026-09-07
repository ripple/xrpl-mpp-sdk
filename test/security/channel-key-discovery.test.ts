import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ChannelLookup,
  type PayChannelLedgerEntry,
  channel as serverChannel,
} from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'

/**
 * A server cannot know a client's channel key before that client opens a
 * channel: the key is chosen in the client's own `PaymentChannelCreate`. So
 * `publicKey` is an allowlist for a bilateral arrangement, not a requirement,
 * and with it unset each channel is verified against the key it names on the
 * ledger.
 *
 * Two things follow, and both are covered here. Funders are no longer limited
 * to one, and a channel key no longer has to be the funder's account key --
 * the protocol lets a funder dedicate a key pair to the channel, which the
 * ledger documentation encourages.
 */
function ledgerEntry(overrides: Partial<PayChannelLedgerEntry>): PayChannelLedgerEntry {
  return {
    Account: 'rFunderPlaceholder',
    Destination: 'rRecipientPlaceholder',
    Amount: '1000000',
    Balance: '0',
    SettleDelay: 3600,
    Expiration: null,
    CancelAfter: null,
    ...overrides,
  }
}

/**
 * @param signer Key pair that signs the claim -- the one the channel names.
 * @param sender Account the credential is sent from, i.e. the channel funder.
 */
function voucher(params: {
  signer: Wallet
  sender: Wallet
  channelId: string
  cumulative: string
  recipient: string
}) {
  const { signer, sender, channelId, cumulative, recipient } = params
  const signature = signer.signChannelClaim(channelId, cumulative)
  const challenge = {
    id: `ch-${channelId.slice(0, 6)}-${cumulative}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: cumulative,
      channelId,
      recipient,
      methodDetails: { network: NETWORK, cumulativeAmount: '0' },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { action: 'voucher', channelId, amount: cumulative, signature },
    source: `did:pkh:xrpl:${NETWORK}:${sender.address}`,
  })
  return { challenge, cred }
}

describe('channel key discovered from the ledger', () => {
  let recipient: Wallet
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    recipient = Wallet.generate()
    store = Store.memory()
  })

  /** A server that accepts any funder: no `publicKey` configured. */
  function openServer(lookup: ChannelLookup, overrides: Record<string, unknown> = {}) {
    return serverChannel({
      recipient: recipient.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: true,
      channelLookup: lookup,
      ...overrides,
    })
  }

  it('accepts two channels from two unrelated funders', async () => {
    const alice = Wallet.generate()
    const bob = Wallet.generate()
    const aliceChannel = 'a'.repeat(64)
    const bobChannel = 'b'.repeat(64)

    // Each channel names its own funder's key, as the ledger would report it.
    const lookup: ChannelLookup = async (channelId) =>
      channelId === aliceChannel
        ? ledgerEntry({
            Account: alice.address,
            Destination: recipient.address,
            PublicKey: alice.publicKey,
          })
        : ledgerEntry({
            Account: bob.address,
            Destination: recipient.address,
            PublicKey: bob.publicKey,
          })

    const method = openServer(lookup)

    const a = voucher({
      signer: alice,
      sender: alice,
      channelId: aliceChannel,
      cumulative: '100000',
      recipient: recipient.address,
    })
    const b = voucher({
      signer: bob,
      sender: bob,
      channelId: bobChannel,
      cumulative: '250000',
      recipient: recipient.address,
    })

    expect(
      (await method.verify({ credential: a.cred as any, request: a.challenge.request })).status,
    ).toBe('success')
    expect(
      (await method.verify({ credential: b.cred as any, request: b.challenge.request })).status,
    ).toBe('success')
  })

  it("accepts a channel key that is not the funder's account key", async () => {
    // The protocol allows this, and recommends it: a key pair dedicated to the
    // channel means its compromise costs the funder that channel, not the
    // account. Binding the credential to an address derived from the channel
    // key would refuse exactly this funder.
    const funder = Wallet.generate()
    const channelKey = Wallet.generate()
    const channelId = 'c'.repeat(64)

    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: recipient.address,
        PublicKey: channelKey.publicKey,
      }),
    )

    const v = voucher({
      signer: channelKey,
      sender: funder,
      channelId,
      cumulative: '100000',
      recipient: recipient.address,
    })

    const result = await openServer(lookup).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(result.status).toBe('success')
  })

  it('rejects a voucher signed by a key the channel does not name', async () => {
    const funder = Wallet.generate()
    const impostor = Wallet.generate()
    const channelId = 'd'.repeat(64)

    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: recipient.address,
        PublicKey: funder.publicKey,
      }),
    )

    // Signed by a key that verifies against nothing on this channel, but sent
    // from the real funder's address, so only the signature can catch it.
    const v = voucher({
      signer: impostor,
      sender: funder,
      channelId,
      cumulative: '100000',
      recipient: recipient.address,
    })

    await expect(
      openServer(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/INVALID_SIGNATURE/)
  })

  it("binds the credential sender to the channel's Account, not to its key", async () => {
    const funder = Wallet.generate()
    const stranger = Wallet.generate()
    const channelId = 'e'.repeat(64)

    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: recipient.address,
        PublicKey: funder.publicKey,
      }),
    )

    // A perfectly valid claim, replayed by someone else under their own DID.
    const v = voucher({
      signer: funder,
      sender: stranger,
      channelId,
      cumulative: '100000',
      recipient: recipient.address,
    })

    await expect(
      openServer(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/SOURCE_MISMATCH/)
  })

  it('still enforces a configured publicKey as an allowlist', async () => {
    const allowed = Wallet.generate()
    const other = Wallet.generate()
    const channelId = 'f'.repeat(64)

    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: other.address,
        Destination: recipient.address,
        PublicKey: other.publicKey,
      }),
    )

    const v = voucher({
      signer: other,
      sender: other,
      channelId,
      cumulative: '100000',
      recipient: recipient.address,
    })

    await expect(
      openServer(lookup, { publicKey: allowed.publicKey }).verify({
        credential: v.cred as any,
        request: v.challenge.request,
      }),
    ).rejects.toThrow(/SOURCE_MISMATCH|INVALID_SIGNATURE/)
  })

  it('refuses to construct without a key and without the ledger', () => {
    // The configured key is the only key that mode has, so leaving it out
    // leaves nothing to verify against.
    expect(() =>
      serverChannel({
        recipient: recipient.address,
        network: NETWORK,
        store,
        storeDurability: 'process-local',
        verifyChannelOnChain: false,
        allowUnverifiedChannels: true,
      }),
    ).toThrow(/verifyChannelOnChain: false requires `publicKey`/)
  })

  it('reports a lookup that omits PublicKey when no key is configured', async () => {
    const funder = Wallet.generate()
    const channelId = '9'.repeat(64)

    // A custom channelLookup may not surface the field. With a configured key
    // that is survivable; without one there is no key at all, and saying so
    // beats verifying against undefined.
    const lookup = vi.fn(async () =>
      ledgerEntry({ Account: funder.address, Destination: recipient.address }),
    )

    const v = voucher({
      signer: funder,
      sender: funder,
      channelId,
      cumulative: '100000',
      recipient: recipient.address,
    })

    await expect(
      openServer(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/no key to verify claims against/)
  })

  it('keeps the configured key usable when a lookup omits PublicKey', async () => {
    const funder = Wallet.generate()
    const channelId = '8'.repeat(64)

    const lookup = vi.fn(async () =>
      ledgerEntry({ Account: funder.address, Destination: recipient.address }),
    )

    const v = voucher({
      signer: funder,
      sender: funder,
      channelId,
      cumulative: '100000',
      recipient: recipient.address,
    })

    const result = await openServer(lookup, { publicKey: funder.publicKey }).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(result.status).toBe('success')
  })
})
