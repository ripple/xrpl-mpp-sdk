import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ChannelLookup,
  type PayChannelLedgerEntry,
  channel as serverChannel,
} from '../../sdk/src/channel/server/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const CHANNEL_ID = '1'.repeat(64)

/**
 * The channel must be shown, from ledger state, to pay this server and to be
 * funded by the key claims verify against. Without those checks a funder can
 * open a channel to their own address, sign valid claims, receive service, and
 * reclaim every drop after SettleDelay.
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

function voucher(funder: Wallet, channelId: string, cumulative: string, recipient: string) {
  const signature = funder.signChannelClaim(channelId, cumulative)
  const challenge = {
    id: `ch-${cumulative}-${Math.random()}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
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
    source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
  })
  return { challenge, cred }
}

describe('channel party verification against ledger state', () => {
  let funder: Wallet
  let recipient: Wallet
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    funder = Wallet.generate()
    recipient = Wallet.generate()
    store = Store.memory()
  })

  function method(lookup: ChannelLookup, overrides: Record<string, unknown> = {}) {
    return serverChannel({
      recipient: recipient.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      channelLookup: lookup,
      ...overrides,
    })
  }

  it('accepts a voucher when the channel pays the configured recipient', async () => {
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: recipient.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    const result = await method(lookup).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(result.status).toBe('success')
  })

  it('rejects a channel whose Destination is the funder itself', async () => {
    // The attack: funder opens and funds a channel to their own address, then
    // signs perfectly valid claims against it.
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: funder.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    await expect(
      method(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/CHANNEL_DESTINATION_MISMATCH/)
  })

  it('rejects a channel that pays an unrelated third party', async () => {
    const thirdParty = Wallet.generate()
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: thirdParty.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    await expect(
      method(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/CHANNEL_DESTINATION_MISMATCH/)
  })

  it('rejects a forged signature, at the cost of one lookup', async () => {
    // The channel names the key its claims verify against, so the lookup has
    // to run before the signature can be checked at all. A forged voucher for
    // an unknown channelId therefore costs one lookup -- the price of
    // accepting funders the server has not met. Metadata is cached per
    // channel, so an established channel costs nothing and a repeated
    // fabricated id is absorbed; a flood of distinct ones is not, and a public
    // deployment should rate-limit ahead of this.
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: recipient.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)
    ;(v.cred as any).payload.signature = 'DEADBEEF'

    await expect(
      method(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/INVALID_SIGNATURE/)

    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('still rejects a bad destination when the signature is genuine', async () => {
    // The destination check is not weakened by running second: a correctly
    // signed voucher against a channel that pays someone else is still refused.
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: funder.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    await expect(
      method(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/CHANNEL_DESTINATION_MISMATCH/)
    expect(lookup).toHaveBeenCalled()
  })

  it("rejects a channel that is someone else's", async () => {
    // Signed by our funder, but the channel belongs to another account and
    // names another key. The signature check reaches it first, which is the
    // cheaper refusal.
    const otherFunder = Wallet.generate()
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: otherFunder.address,
        Destination: recipient.address,
        PublicKey: otherFunder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    await expect(
      method(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/INVALID_SIGNATURE/)
  })

  it("rejects a credential sent from someone other than the channel's Account", async () => {
    // The channel names our funder's key, so the claim verifies -- but the
    // channel belongs to a different account, and the sender must be that
    // account. This replaced a check that the Account derive from the channel
    // key, which the protocol does not require.
    const impostor = Wallet.generate()
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: impostor.address,
        Destination: recipient.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    await expect(
      method(lookup).verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/SOURCE_MISMATCH/)
  })

  it('verifies claims against the on-ledger PublicKey whatever its casing', async () => {
    // Hex is case-insensitive as a value, and a lookup may report either
    // casing. The key is the ledger's, so both spellings must verify.
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: recipient.address,
        PublicKey: funder.publicKey.toLowerCase(),
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    const result = await method(lookup).verify({
      credential: v.cred as any,
      request: v.challenge.request,
    })
    expect(result.status).toBe('success')
  })

  it('derives the expected recipient from the configured wallet', async () => {
    const lookup = vi.fn(async () =>
      ledgerEntry({
        Account: funder.address,
        Destination: funder.address,
        PublicKey: funder.publicKey,
      }),
    )
    const v = voucher(funder, CHANNEL_ID, '100000', recipient.address)

    const withWallet = serverChannel({
      wallet: recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      channelLookup: lookup,
      autoClose: false,
    })

    await expect(
      withWallet.verify({ credential: v.cred as any, request: v.challenge.request }),
    ).rejects.toThrow(/CHANNEL_DESTINATION_MISMATCH/)
  })

  it('throws when recipient and wallet disagree', () => {
    expect(() =>
      serverChannel({
        recipient: recipient.address,
        wallet: Wallet.generate(),
        network: NETWORK,
        store,
        storeDurability: 'process-local',
        autoClose: false,
      }),
    ).toThrow('does not match the configured wallet')
  })

  it('warns when neither recipient nor wallet is configured', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    serverChannel({
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('on-chain channel Destination cannot be checked'),
      'XrplMppSdkWarning',
    )
    warn.mockRestore()
  })
})
