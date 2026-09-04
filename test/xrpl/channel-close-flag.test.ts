import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'

/**
 * `close()` builds one `PaymentChannelClaim` and everything about whether the
 * channel actually closes rides on its `Flags`.
 *
 * The two flags differ by one bit and the wrong one fails silently: `tfRenew`
 * (0x00010000) clears the channel's `Expiration`, so the claim still settles,
 * the transaction still returns tesSUCCESS, and the channel quietly survives
 * the call that was meant to delete it. Nothing short of reading the ledger
 * entry afterwards tells the two apart, which is why this pins the constant
 * rather than the outcome.
 */
const TF_RENEW = 0x00010000
const TF_CLOSE = 0x00020000

const FUNDER = 'rFunderAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const DEST = 'rDestBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const CHANNEL_ID = 'A'.repeat(64)
const PUBLIC_KEY = `ED${'0'.repeat(64)}`

const submitted: any[] = []

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async request(params: any) {
      if (params.command === 'ledger_entry') {
        return {
          result: {
            node: {
              Account: FUNDER,
              Destination: DEST,
              Amount: '5000000',
              Balance: '0',
              PublicKey: PUBLIC_KEY,
              SettleDelay: 3600,
            },
          },
        }
      }
      throw new Error(`unexpected command ${params.command}`)
    }
    async submitAndWait(tx: any) {
      submitted.push(tx)
      return { result: { hash: 'C'.repeat(64), meta: { TransactionResult: 'tesSUCCESS' } } }
    }
  }
  return { ...actual, Client: FakeClient }
})

const { close } = await import('../../sdk/src/channel/server/Channel.js')

function walletFor(address: string) {
  return {
    address,
    publicKey: PUBLIC_KEY,
    _xrplWallet: { classicAddress: address },
  } as never
}

async function closeAs(address: string) {
  submitted.length = 0
  await close({
    channelId: CHANNEL_ID,
    wallet: walletFor(address),
    amount: '1000000',
    signature: 'ab'.repeat(32),
    channelPublicKey: PUBLIC_KEY,
    network: 'testnet',
  })
  return submitted[0]
}

describe('close() sets the flag that actually closes', () => {
  it('sends tfClose, not tfRenew', async () => {
    const tx = await closeAs(DEST)
    expect(tx.Flags).toBe(TF_CLOSE)
    expect(tx.Flags).not.toBe(TF_RENEW)
  })

  it('sets it when the destination closes', async () => {
    // The ledger accepts tfClose from the destination and applies it
    // immediately. Omitting it here left every server-side sweep collecting
    // its money and leaving the channel open.
    const tx = await closeAs(DEST)
    expect(tx.Flags).toBe(TF_CLOSE)
  })

  it('sets it when the source closes', async () => {
    const tx = await closeAs(FUNDER)
    expect(tx.Flags).toBe(TF_CLOSE)
  })

  it('refuses a party that is neither source nor destination', async () => {
    submitted.length = 0
    await expect(closeAs('rStrangerCCCCCCCCCCCCCCCCCCCCCCCCC')).rejects.toThrow(
      /neither, so it cannot close it/,
    )
    expect(submitted, 'nothing should reach the ledger').toHaveLength(0)
  })

  it('still carries the claim so the close also settles', async () => {
    const tx = await closeAs(DEST)
    expect(tx.TransactionType).toBe('PaymentChannelClaim')
    expect(tx.Balance).toBe('1000000')
    expect(tx.Signature).toBe('AB'.repeat(32))
  })
})
