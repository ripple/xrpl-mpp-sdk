import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'
import { rippleTimeToUnixTime } from 'xrpl'

/**
 * `CancelAfter` is ripple time on the wire, seconds since 2000-01-01, and this
 * field used to take that value raw while `expiresAt` in the same options
 * object took Unix milliseconds. A caller passing a Unix timestamp therefore
 * got a deadline roughly thirty years out, accepted by the ledger without
 * complaint -- silently disabling the one field whose purpose is to bound how
 * long a channel can outlive its session.
 */
let lastTx: Record<string, unknown> = {}

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async autofill(tx: any) {
      // The transaction as the SDK built it, before signing: reading CancelAfter
      // here needs no binary decoder and no extra dependency.
      lastTx = tx
      return { ...tx, Sequence: 1, Fee: '10', LastLedgerSequence: 100 }
    }
    async request(params: any) {
      if (params.command === 'server_state') {
        return {
          result: {
            state: {
              validated_ledger: { reserve_base: 1_000_000, reserve_inc: 200_000, seq: 100 },
            },
          },
        }
      }
      if (params.command === 'account_info') {
        return { result: { account_data: { Balance: '100000000', OwnerCount: 0 } } }
      }
      if (params.command === 'ledger_current') return { result: { ledger_current_index: 100 } }
      throw new Error(`unexpected ${params.command}`)
    }
    async submitAndWait(_blob: string) {
      return {
        result: {
          hash: 'A'.repeat(64),
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              { CreatedNode: { LedgerEntryType: 'PayChannel', LedgerIndex: 'B'.repeat(64) } },
            ],
          },
        },
      }
    }
  }
  return { ...actual, Client: FakeClient }
})

const { prepareOpenChannelTransaction } = await import('../../sdk/src/channel/client/Channel.js')
const { Wallet } = await import('../../sdk/src/utils/wallet.js')
async function cancelAfterOf(input: Date | number | string): Promise<number> {
  const wallet = Wallet.generate()
  await prepareOpenChannelTransaction({
    wallet,
    destination: Wallet.generate().address,
    amount: '5000000',
    settleDelay: 3600,
    cancelAfter: input,
    network: 'testnet',
  })
  return lastTx.CancelAfter as number
}

describe('cancelAfter takes the same shapes as everything else', () => {
  const target = Date.now() + 3_600_000

  it('reads a Date, Unix milliseconds and an ISO string the same way', async () => {
    // Ripple time is whole seconds and an ISO round trip drops the
    // milliseconds, so the three forms agree to the second rather than exactly.
    for (const input of [new Date(target), target, new Date(target).toISOString()]) {
      const ripple = await cancelAfterOf(input)
      const drift = Math.abs(rippleTimeToUnixTime(ripple) - target)
      expect(drift, String(input)).toBeLessThanOrEqual(1000)
    }
  })

  it('does not read a number as ripple time', async () => {
    // The regression: treating Unix milliseconds as ripple seconds put the
    // deadline decades away instead of an hour.
    const ripple = await cancelAfterOf(target)
    const years = (rippleTimeToUnixTime(ripple) - Date.now()) / (365 * 24 * 3_600_000)
    expect(years).toBeLessThan(1)
  })

  it('refuses a deadline already in the past', async () => {
    await expect(cancelAfterOf(Date.now() - 1000)).rejects.toThrow(/must be in the future/)
  })
})
