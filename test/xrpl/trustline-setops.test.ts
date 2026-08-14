/**
 * Unit tests for the new trustline / issuer operations exposed via the Wallet
 * API. These tests exercise the internal utils directly because every Wallet
 * method is a thin wrapper around them (open Client + delegate + dispose);
 * testing the wrappers separately would just be exercising xrpl.Client.
 */
import { describe, expect, it, vi } from 'vitest'
import { Wallet as XrplWallet } from 'xrpl'
import {
  ASF_DEFAULT_RIPPLE,
  authorizeTrustline,
  getTrustline,
  issuePayment,
  listTrustlines,
  removeTrustline,
  setAccountFlag,
  setTrustline,
} from '../../sdk/src/utils/trustline.js'

const ISSUER = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'
const HOLDER = 'rHolder1234567890123456789012345'
const CURRENCY = { currency: 'USD', issuer: ISSUER }

const LSF_DEFAULT_RIPPLE = 0x00800000
const LSF_REQUIRE_AUTH = 0x00040000

const TF_SET_F_AUTH = 0x00010000

function mockClient(handlers: {
  accountLines?: (params: any) => any
  // Sequence of responses to consecutive `account_lines` calls. Useful when a
  // single function calls `account_lines` twice (e.g. removeTrustline reads
  // before submit and after submit to detect lingering auth flags).
  accountLinesSeq?: Array<() => any>
  accountInfoSelf?: () => any
  accountInfoIssuer?: () => any
  serverState?: () => any
  submitAndWait?: (tx: any) => any
}): any {
  let accountLinesIndex = 0
  return {
    request: vi.fn(async (params: any) => {
      switch (params.command) {
        case 'account_lines': {
          if (handlers.accountLinesSeq) {
            const fn =
              handlers.accountLinesSeq[accountLinesIndex] ?? handlers.accountLinesSeq.at(-1)
            accountLinesIndex += 1
            return fn?.() ?? { result: { lines: [] } }
          }
          return handlers.accountLines?.(params) ?? { result: { lines: [] } }
        }
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
          result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'TXHASH' },
        },
    ),
  }
}

// ============================================================================
// setTrustline
// ============================================================================

describe('setTrustline', () => {
  it('returns "unchanged" when an authorised line at the same limit already exists', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountLines: () => ({
        result: {
          lines: [{ currency: 'USD', account: ISSUER, balance: '0', limit: '10000' }],
        },
      }),
    })
    const result = await setTrustline(client, wallet, CURRENCY)
    expect(result).toEqual({ status: 'unchanged' })
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('returns "created" with hash when no existing line', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({})
    const result = await setTrustline(client, wallet, CURRENCY, { limit: '500' })
    expect(result).toEqual({ status: 'created', hash: 'TXHASH' })
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.TransactionType).toBe('TrustSet')
    expect(tx.LimitAmount.value).toBe('500')
  })

  it('returns "updated" when the limit changed', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountLines: () => ({
        result: {
          lines: [{ currency: 'USD', account: ISSUER, balance: '0', limit: '1000' }],
        },
      }),
    })
    const result = await setTrustline(client, wallet, CURRENCY, { limit: '2000' })
    expect(result).toEqual({ status: 'updated', hash: 'TXHASH' })
  })

  it('returns "pending_authorization" without resubmitting when line exists at right limit but is unauthorised', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountLines: () => ({
        result: {
          lines: [
            {
              currency: 'USD',
              account: ISSUER,
              balance: '0',
              limit: '10000',
              authorized: false,
            },
          ],
        },
      }),
      accountInfoIssuer: () => ({
        result: { account_data: { Flags: LSF_DEFAULT_RIPPLE | LSF_REQUIRE_AUTH } },
      }),
    })
    const result = await setTrustline(client, wallet, CURRENCY)
    expect(result.status).toBe('pending_authorization')
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('returns "pending_authorization" with hash on first creation when issuer requires auth', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountInfoIssuer: () => ({
        result: { account_data: { Flags: LSF_DEFAULT_RIPPLE | LSF_REQUIRE_AUTH } },
      }),
    })
    const result = await setTrustline(client, wallet, CURRENCY)
    expect(result).toEqual({ status: 'pending_authorization', hash: 'TXHASH' })
    expect(client.submitAndWait).toHaveBeenCalledTimes(1)
  })

  it('throws TRUSTLINE_FAILED when the ledger rejects the TrustSet', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      submitAndWait: () => ({
        result: { meta: { TransactionResult: 'tecINSUFFICIENT_RESERVE' }, hash: 'X' },
      }),
    })
    await expect(setTrustline(client, wallet, CURRENCY)).rejects.toThrow(/TRUSTLINE_FAILED/)
  })
})

// ============================================================================
// removeTrustline
// ============================================================================

describe('removeTrustline', () => {
  it('returns "absent" when no line exists', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({})
    const result = await removeTrustline(client, wallet, CURRENCY)
    expect(result).toEqual({ status: 'absent' })
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('refuses to submit if the line still has a balance', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountLines: () => ({
        result: {
          lines: [{ currency: 'USD', account: ISSUER, balance: '42', limit: '10000' }],
        },
      }),
    })
    await expect(removeTrustline(client, wallet, CURRENCY)).rejects.toThrow(/TRUSTLINE_HAS_BALANCE/)
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('returns "removed" when the trustline disappears post-submit', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountLinesSeq: [
        // Pre-submit: the line exists, balance 0 so removal is allowed.
        () => ({
          result: {
            lines: [{ currency: 'USD', account: ISSUER, balance: '0', limit: '10000' }],
          },
        }),
        // Post-submit: ledger entry deleted (no lingering flags).
        () => ({ result: { lines: [] } }),
      ],
    })
    const result = await removeTrustline(client, wallet, CURRENCY)
    expect(result).toEqual({ status: 'removed', hash: 'TXHASH' })
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.LimitAmount.value).toBe('0')
  })

  it('returns "cleared" when the trustline persists post-submit (RequireAuth case)', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({
      accountLinesSeq: [
        // Pre-submit: authorised line, balance 0.
        () => ({
          result: {
            lines: [
              {
                currency: 'USD',
                account: ISSUER,
                balance: '0',
                limit: '10000',
                authorized: true,
              },
            ],
          },
        }),
        // Post-submit: line still there at limit=0 (issuer auth flag pins it).
        () => ({
          result: {
            lines: [
              {
                currency: 'USD',
                account: ISSUER,
                balance: '0',
                limit: '0',
                authorized: true,
              },
            ],
          },
        }),
      ],
    })
    const result = await removeTrustline(client, wallet, CURRENCY)
    expect(result).toEqual({ status: 'cleared', hash: 'TXHASH' })
  })
})

// ============================================================================
// getTrustline / listTrustlines
// ============================================================================

describe('read helpers', () => {
  it('getTrustline returns null when no line', async () => {
    const client = mockClient({})
    const r = await getTrustline(client, HOLDER, CURRENCY)
    expect(r).toBeNull()
  })

  it('getTrustline returns a normalised TrustlineInfo when present', async () => {
    const client = mockClient({
      accountLines: () => ({
        result: {
          lines: [
            {
              currency: 'USD',
              account: ISSUER,
              balance: '5',
              limit: '100',
              freeze_peer: true,
              no_ripple: true,
            },
          ],
        },
      }),
    })
    const r = await getTrustline(client, HOLDER, CURRENCY)
    expect(r).toEqual({
      currency: 'USD',
      issuer: ISSUER,
      balance: '5',
      limit: '100',
      authorized: true,
      frozen: true,
      noRipple: true,
    })
  })

  it('listTrustlines returns [] when account does not exist', async () => {
    const client = {
      request: vi.fn().mockRejectedValue({ data: { error: 'actNotFound' } }),
      submitAndWait: vi.fn(),
    }
    const r = await listTrustlines(client as any, HOLDER)
    expect(r).toEqual([])
  })
})

// ============================================================================
// authorizeTrustline (issuer-side, tfSetfAuth)
// ============================================================================

describe('issuer-side authorize TrustSet', () => {
  it('authorizeTrustline submits a TrustSet with tfSetfAuth on the issuer side', async () => {
    const issuer = XrplWallet.generate()
    const currency = { currency: 'USD', issuer: issuer.classicAddress }
    const client = mockClient({})
    const result = await authorizeTrustline(client, issuer, HOLDER, currency)
    expect(result).toEqual({ hash: 'TXHASH' })
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.TransactionType).toBe('TrustSet')
    expect(tx.Account).toBe(issuer.classicAddress)
    expect(tx.Flags).toBe(TF_SET_F_AUTH)
    expect(tx.LimitAmount).toEqual({ currency: 'USD', issuer: HOLDER, value: '0' })
  })

  it('authorizeTrustline rejects when the wallet is not the currency issuer', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({})
    await expect(authorizeTrustline(client, wallet, HOLDER, CURRENCY)).rejects.toThrow(
      /does not match/,
    )
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })
})

// ============================================================================
// issuePayment
// ============================================================================

describe('issuer-side payments', () => {
  it('issuePayment builds a Payment with the issuer as Account', async () => {
    const issuer = XrplWallet.generate()
    const currency = { currency: 'USD', issuer: issuer.classicAddress }
    const client = mockClient({})
    await issuePayment(client, issuer, HOLDER, '500', currency)
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.TransactionType).toBe('Payment')
    expect(tx.Account).toBe(issuer.classicAddress)
    expect(tx.Destination).toBe(HOLDER)
    expect(tx.Amount).toEqual({
      currency: 'USD',
      issuer: issuer.classicAddress,
      value: '500',
    })
  })

  it('issuePayment rejects when the wallet is not the currency issuer', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({})
    await expect(issuePayment(client, wallet, HOLDER, '1', CURRENCY)).rejects.toThrow(
      /does not match/,
    )
  })
})

// ============================================================================
// setAccountFlag (DefaultRipple)
// ============================================================================

describe('setAccountFlag', () => {
  it('builds AccountSet with SetFlag when enable=true', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({})
    await setAccountFlag(client, wallet, ASF_DEFAULT_RIPPLE, true)
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.TransactionType).toBe('AccountSet')
    expect(tx.SetFlag).toBe(ASF_DEFAULT_RIPPLE)
    expect(tx.ClearFlag).toBeUndefined()
  })

  it('builds AccountSet with ClearFlag when enable=false', async () => {
    const wallet = XrplWallet.generate()
    const client = mockClient({})
    await setAccountFlag(client, wallet, ASF_DEFAULT_RIPPLE, false)
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.ClearFlag).toBe(ASF_DEFAULT_RIPPLE)
    expect(tx.SetFlag).toBeUndefined()
  })
})
