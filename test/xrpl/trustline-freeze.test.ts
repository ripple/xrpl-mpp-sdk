import { describe, expect, it, vi } from 'vitest'
import { Wallet } from 'xrpl'
import { ensureTrustline } from '../../sdk/src/utils/trustline.js'

const ISSUER = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
const CURRENCY = { currency: 'USD', issuer: ISSUER }

const LSF_DEFAULT_RIPPLE = 0x00800000
const LSF_GLOBAL_FREEZE = 0x00400000
const LSF_REQUIRE_AUTH = 0x00040000

function mockClient(handlers: {
  accountLines?: () => any
  accountInfoSelf?: () => any
  accountInfoIssuer?: () => any
  serverState?: () => any
  submitAndWait?: (tx: any) => any
}): any {
  return {
    request: vi.fn(async (params: any) => {
      switch (params.command) {
        case 'account_lines':
          return handlers.accountLines?.() ?? { result: { lines: [] } }
        case 'account_info': {
          if (params.account === ISSUER) {
            return (
              handlers.accountInfoIssuer?.() ?? {
                result: { account_data: { Flags: LSF_DEFAULT_RIPPLE } },
              }
            )
          }
          return (
            handlers.accountInfoSelf?.() ?? {
              result: { account_data: { Balance: '5000000', OwnerCount: 0, Flags: 0 } },
            }
          )
        }
        case 'server_state':
          return (
            handlers.serverState?.() ?? {
              result: {
                state: { validated_ledger: { reserve_base: '1000000', reserve_inc: '200000' } },
              },
            }
          )
        default:
          throw new Error(`unmocked command: ${params.command}`)
      }
    }),
    submitAndWait: vi.fn(
      async (tx: any) =>
        handlers.submitAndWait?.(tx) ?? {
          result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'h' },
        },
    ),
  }
}

describe('ensureTrustline -- freeze, require-auth, reserve checks', () => {
  it('short-circuits when trustline already exists', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountLines: () => ({
        result: { lines: [{ currency: 'USD', authorized: true, balance: '0', limit: '10000' }] },
      }),
    })
    await ensureTrustline({
      client,
      wallet,
      currency: CURRENCY,
      autoTrustline: true,
    })
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('throws MISSING_TRUSTLINE when autoTrustline=false and no line exists', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountLines: () => ({ result: { lines: [] } }),
    })
    await expect(
      ensureTrustline({ client, wallet, currency: CURRENCY, autoTrustline: false }),
    ).rejects.toThrow(/MISSING_TRUSTLINE/)
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('throws ISSUER_GLOBAL_FROZEN when issuer has lsfGlobalFreeze', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountLines: () => ({ result: { lines: [] } }),
      accountInfoIssuer: () => ({
        result: { account_data: { Flags: LSF_DEFAULT_RIPPLE | LSF_GLOBAL_FREEZE } },
      }),
    })
    await expect(
      ensureTrustline({ client, wallet, currency: CURRENCY, autoTrustline: true }),
    ).rejects.toThrow(/ISSUER_GLOBAL_FROZEN/)
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('throws INSUFFICIENT_RESERVE when account cannot cover one more owner object', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountLines: () => ({ result: { lines: [] } }),
      accountInfoSelf: () => ({
        // 1 XRP base + 0 owners; needs 1.2 XRP for one more owner; 1 XRP is not enough.
        result: { account_data: { Balance: '1000000', OwnerCount: 0 } },
      }),
    })
    await expect(
      ensureTrustline({ client, wallet, currency: CURRENCY, autoTrustline: true }),
    ).rejects.toThrow(/INSUFFICIENT_RESERVE.*TrustSet/)
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('submits TrustSet when issuer is healthy and reserves are OK', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountLines: () => ({ result: { lines: [] } }),
    })
    await ensureTrustline({ client, wallet, currency: CURRENCY, autoTrustline: true })
    expect(client.submitAndWait).toHaveBeenCalledTimes(1)
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.TransactionType).toBe('TrustSet')
    expect(tx.LimitAmount).toEqual({ currency: 'USD', issuer: ISSUER, value: '10000' })
  })

  it('after submit, surfaces TRUSTLINE_REQUIRES_AUTH if issuer has asfRequireAuth', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountLines: () => ({ result: { lines: [] } }),
      accountInfoIssuer: () => ({
        result: { account_data: { Flags: LSF_DEFAULT_RIPPLE | LSF_REQUIRE_AUTH } },
      }),
    })
    await expect(
      ensureTrustline({ client, wallet, currency: CURRENCY, autoTrustline: true }),
    ).rejects.toThrow(/TRUSTLINE_REQUIRES_AUTH/)
    // The TrustSet *did* go through; the issuer must now authorise.
    expect(client.submitAndWait).toHaveBeenCalledTimes(1)
  })
})
