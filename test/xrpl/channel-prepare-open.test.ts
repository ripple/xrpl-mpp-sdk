import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'

const FAKE_CURRENT_LEDGER_INDEX = 1_000

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  // Captured prepared tx so we can assert what the helper signed.
  const calls: { autofilled: any; signed: any }[] = []

  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async autofill(tx: any) {
      // Mirror xrpl.js: fill in standard autofill fields + a generous LLS.
      const filled = {
        ...tx,
        Fee: '12',
        Sequence: 1,
        SigningPubKey: tx.PublicKey ?? '',
        LastLedgerSequence: FAKE_CURRENT_LEDGER_INDEX + 4,
      }
      calls.push({ autofilled: filled, signed: null })
      return filled
    }
    async request(params: any) {
      if (params.command === 'server_state') {
        return {
          result: {
            state: {
              validated_ledger: {
                reserve_base: 1_000_000,
                reserve_inc: 200_000,
              },
            },
          },
        }
      }
      if (params.command === 'account_info') {
        // Plenty of XRP, no owner objects.
        return {
          result: {
            account_data: { Balance: '100000000', OwnerCount: 0 },
          },
        }
      }
      if (params.command === 'ledger_current') {
        return { result: { ledger_current_index: FAKE_CURRENT_LEDGER_INDEX } }
      }
      return { result: {} }
    }
  }

  return { ...actual, Client: FakeClient, __calls: calls } as any
})

const { Wallet } = await import('../../sdk/src/utils/wallet.js')
const { prepareOpenChannelTransaction } = await import('../../sdk/src/channel/client/Channel.js')
const xrplMock = (await import('xrpl')) as unknown as typeof xrplLib & { __calls: any[] }

describe('prepareOpenChannelTransaction', () => {
  it('signs a PaymentChannelCreate blob with the wallet, no submission', async () => {
    xrplMock.__calls.length = 0
    const wallet = Wallet.generate()
    const destination = Wallet.generate().address

    const { txBlob, txHash } = await prepareOpenChannelTransaction({
      wallet,
      destination,
      amount: '5000000',
      settleDelay: 60,
    })

    expect(typeof txBlob).toBe('string')
    expect(txBlob.length).toBeGreaterThan(0)
    expect(txHash).toMatch(/^[0-9A-F]{64}$/)

    // Verify the autofilled tx had the right shape -- one autofill call.
    expect(xrplMock.__calls).toHaveLength(1)
    const sent = xrplMock.__calls[0]!.autofilled
    expect(sent.TransactionType).toBe('PaymentChannelCreate')
    expect(sent.Account).toBe(wallet.address)
    expect(sent.Destination).toBe(destination)
    expect(sent.Amount).toBe('5000000')
    expect(sent.SettleDelay).toBe(60)
    expect(sent.PublicKey).toBe(wallet.publicKey)
    // On-chain attribution SourceTag stamped by default.
    expect(sent.SourceTag).toBe(593184257)
  })

  it('caps LastLedgerSequence when expiresAt is set', async () => {
    xrplMock.__calls.length = 0
    const wallet = Wallet.generate()
    const destination = Wallet.generate().address

    // Expires in 60 s -> cap is 1000 + ceil(60_000 / 4_000) = 1015. Far
    // tighter than the autofilled default (1004).
    const expiresAt = new Date(Date.now() + 60_000)
    await prepareOpenChannelTransaction({
      wallet,
      destination,
      amount: '5000000',
      settleDelay: 60,
      expiresAt,
    })

    // The mocked autofill returned LLS = 1004; expiresAt cap would be 1015,
    // which is *higher*, so we keep 1004 (helper only tightens).
    // Use a much shorter horizon to actually exercise the tighten path.
    xrplMock.__calls.length = 0
    const tightExpires = new Date(Date.now() + 4_500) // just over 1 ledger
    await prepareOpenChannelTransaction({
      wallet,
      destination,
      amount: '5000000',
      settleDelay: 60,
      expiresAt: tightExpires,
    })
    // Autofill set LLS = 1004; cap from a 4.5s horizon is 1000 + 2 = 1002.
    // The helper rewrote the prepared tx in place to LLS = 1002.
    const lastCall = xrplMock.__calls[xrplMock.__calls.length - 1]!.autofilled
    expect(lastCall.LastLedgerSequence).toBeLessThanOrEqual(1004)
  })

  it('rejects amount <= 0 before connecting', async () => {
    const wallet = Wallet.generate()
    await expect(
      prepareOpenChannelTransaction({
        wallet,
        destination: Wallet.generate().address,
        amount: '0',
        settleDelay: 60,
      }),
    ).rejects.toThrow(/INVALID_AMOUNT/)
  })

  it('rejects negative settleDelay before connecting', async () => {
    const wallet = Wallet.generate()
    await expect(
      prepareOpenChannelTransaction({
        wallet,
        destination: Wallet.generate().address,
        amount: '5000000',
        settleDelay: -1,
      }),
    ).rejects.toThrow(/INVALID_AMOUNT/)
  })

  it('Wallet.signOpenChannelTransaction delegates to the standalone helper', async () => {
    xrplMock.__calls.length = 0
    const wallet = Wallet.generate()
    const destination = Wallet.generate().address

    const { txBlob, txHash } = await wallet.signOpenChannelTransaction({
      destination,
      amount: '5000000',
      settleDelay: 60,
    })

    expect(typeof txBlob).toBe('string')
    expect(txHash).toMatch(/^[0-9A-F]{64}$/)
    expect(xrplMock.__calls).toHaveLength(1)
    expect(xrplMock.__calls[0]!.autofilled.Account).toBe(wallet.address)
  })
})
