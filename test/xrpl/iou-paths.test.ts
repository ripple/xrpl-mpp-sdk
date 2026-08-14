import { describe, expect, it, vi } from 'vitest'
import { resolveIouPaymentExtras, validateSlippageBps } from '../../sdk/src/utils/paths.js'

const SENDER = 'rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC'
const RECIPIENT = 'rNsjK2ucpiMJrjamrSvZDwkwX7kkdBZXJc'
const ISSUER_A = 'r3K9zyvHHDmLDS62AGUtYzJaUtqb69WJEm'
const ISSUER_B = 'rEPw2RiCgkSJut84z1mret8PDqeyXyU7Q8'

type MockHandlers = {
  accountInfo?: (params: any) => any
  accountLines?: (params: any) => any
  ripplePathFind?: (params: any) => any
}

function mockClient(handlers: MockHandlers): any {
  return {
    request: vi.fn(async (params: any) => {
      switch (params.command) {
        case 'account_info':
          return (
            handlers.accountInfo?.(params) ?? {
              result: { account_data: { Balance: '1000000', OwnerCount: 0 } },
            }
          )
        case 'account_lines':
          return handlers.accountLines?.(params) ?? { result: { lines: [] } }
        case 'ripple_path_find':
          return handlers.ripplePathFind?.(params) ?? { result: { alternatives: [] } }
        default:
          throw new Error(`unmocked command: ${params.command}`)
      }
    }),
  }
}

describe('validateSlippageBps', () => {
  it('accepts integers in [0, 1000]', () => {
    expect(() => validateSlippageBps(0)).not.toThrow()
    expect(() => validateSlippageBps(50)).not.toThrow()
    expect(() => validateSlippageBps(1000)).not.toThrow()
  })

  it('rejects negative slippage', () => {
    expect(() => validateSlippageBps(-1)).toThrow(/INVALID_AMOUNT/)
  })

  it('rejects slippage > 1000 (more than 10%)', () => {
    expect(() => validateSlippageBps(1001)).toThrow(/INVALID_AMOUNT/)
    expect(() => validateSlippageBps(50_000)).toThrow(/INVALID_AMOUNT/)
  })

  it('rejects non-integer (float) slippage', () => {
    expect(() => validateSlippageBps(50.5)).toThrow(/INVALID_AMOUNT/)
  })

  it('rejects non-finite values', () => {
    expect(() => validateSlippageBps(Number.NaN)).toThrow(/INVALID_AMOUNT/)
    expect(() => validateSlippageBps(Number.POSITIVE_INFINITY)).toThrow(/INVALID_AMOUNT/)
  })
})

describe('resolveIouPaymentExtras', () => {
  describe('self-issued IOU (sender == issuer)', () => {
    it('skips both account_lines and ripple_path_find, returns no Paths/SendMax', async () => {
      const client = mockClient({})
      const out = await resolveIouPaymentExtras({
        client,
        sender: ISSUER_A,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 50,
      })
      expect(out.strategy).toBe('self-issued')
      expect(out.Paths).toBeUndefined()
      expect(out.SendMax).toBeUndefined()
      expect(out.sourceAmountValue).toBe('100')
      expect(client.request).not.toHaveBeenCalled()
    })
  })

  describe('direct trustline (sender + recipient both hold the same issuer)', () => {
    it('skips ripple_path_find, attaches no Paths, sets SendMax with default slippage', async () => {
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }), // no TransferRate
        accountLines: ({ account }: any) => {
          // Both sender and recipient hold the same issuer's USD trustline.
          if (account === RECIPIENT || account === SENDER) {
            return { result: { lines: [{ currency: 'USD', account: ISSUER_A, balance: '100' }] } }
          }
          return { result: { lines: [] } }
        },
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 50,
        pathFindRetryDelaysMs: [],
      })
      expect(out.strategy).toBe('direct-trustline')
      expect(out.Paths).toBeUndefined()
      expect(out.SendMax).toEqual({
        currency: 'USD',
        issuer: ISSUER_A,
        value: '100.5',
      })
      expect(out.sourceAmountValue).toBe('100')
      // No path-find should have been issued.
      const calls = client.request.mock.calls.map((c: any[]) => c[0].command)
      expect(calls).not.toContain('ripple_path_find')
    })

    it('factors TransferRate into SendMax (1.005e9 = 0.5% fee)', async () => {
      const client = mockClient({
        accountInfo: ({ account }: any) => {
          if (account === ISSUER_A) {
            return { result: { account_data: { TransferRate: 1_005_000_000 } } }
          }
          return { result: { account_data: {} } }
        },
        accountLines: ({ account }: any) => {
          if (account === RECIPIENT || account === SENDER) {
            return { result: { lines: [{ currency: 'USD', account: ISSUER_A, balance: '100' }] } }
          }
          return { result: { lines: [] } }
        },
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 50,
        pathFindRetryDelaysMs: [],
      })
      expect(out.strategy).toBe('direct-trustline')
      // sourceAmount = 100 * 1.005 = 100.5
      // SendMax = 100.5 * 1.005 = 101.0025
      expect(out.sourceAmountValue).toBe('100.5')
      const sendMax = out.SendMax as { value: string }
      expect(sendMax.value).toBe('101.0025')
    })

    it('respects custom slippageBps', async () => {
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: ({ account }: any) => {
          if (account === RECIPIENT || account === SENDER) {
            return { result: { lines: [{ currency: 'USD', account: ISSUER_A, balance: '100' }] } }
          }
          return { result: { lines: [] } }
        },
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '1000' },
        slippageBps: 200, // 2%
      })
      const sendMax = out.SendMax as { value: string }
      expect(sendMax.value).toBe('1020')
    })
  })

  describe('cross-issuer (sender or recipient missing the same trustline)', () => {
    it('falls through to path-find when recipient holds Amount.issuer but sender does not', async () => {
      // Recipient trusts USD.IssuerA. Sender trusts USD.IssuerB only. Cannot
      // direct-ripple; must go through the orderbook.
      const altSourceAmount = { currency: 'USD', issuer: ISSUER_B, value: '105' }
      const altPaths = [[{ account: ISSUER_B, type: 1 }]]
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: ({ account }: any) => {
          if (account === RECIPIENT) {
            return { result: { lines: [{ currency: 'USD', account: ISSUER_A, balance: '0' }] } }
          }
          if (account === SENDER) {
            return { result: { lines: [{ currency: 'USD', account: ISSUER_B, balance: '500' }] } }
          }
          return { result: { lines: [] } }
        },
        ripplePathFind: () => ({
          result: { alternatives: [{ source_amount: altSourceAmount, paths_computed: altPaths }] },
        }),
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 0,
        pathFindRetryDelaysMs: [],
      })
      expect(out.strategy).toBe('cross-issuer')
      expect(out.Paths).toEqual(altPaths)
    })

    it('calls ripple_path_find, attaches Paths, sets SendMax with default slippage', async () => {
      const altSourceAmount = { currency: 'EUR', issuer: ISSUER_B, value: '110' }
      const altPaths = [
        [
          { account: ISSUER_B, type: 1 },
          { currency: 'USD', issuer: ISSUER_A, type: 48 },
        ],
      ]
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }), // no TransferRate
        accountLines: ({ account }: any) => {
          if (account === SENDER) {
            return { result: { lines: [{ currency: 'EUR', account: ISSUER_B, balance: '500' }] } }
          }
          return { result: { lines: [] } }
        },
        ripplePathFind: () => ({
          result: {
            alternatives: [{ source_amount: altSourceAmount, paths_computed: altPaths }],
          },
        }),
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 50,
        pathFindRetryDelaysMs: [],
      })
      expect(out.strategy).toBe('cross-issuer')
      // Use toMatchObject so the test doesn't fail if the resolver attaches
      // extra alternative-derived metadata in the future.
      expect(out.Paths).toEqual(altPaths)
      expect(out.SendMax).toEqual({ currency: 'EUR', issuer: ISSUER_B, value: '110.55' })
      expect(out.sourceAmountValue).toBe('110')
      expect(out.sourceAmountCurrency).toBe('EUR')
    })

    it('picks the cheapest alternative when multiple are returned', async () => {
      const expensive = {
        source_amount: { currency: 'EUR', issuer: ISSUER_B, value: '125' },
        paths_computed: [[{ account: 'rExpensive', type: 1 }]],
      }
      const cheap = {
        source_amount: { currency: 'EUR', issuer: ISSUER_B, value: '105' },
        paths_computed: [[{ account: 'rCheap', type: 1 }]],
      }
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: () => ({ result: { lines: [] } }),
        ripplePathFind: () => ({ result: { alternatives: [expensive, cheap] } }),
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 0,
        pathFindRetryDelaysMs: [],
      })
      expect((out.SendMax as { value: string }).value).toBe('105')
      expect(out.Paths).toEqual(cheap.paths_computed)
    })

    it('handles XRP-bridged source_amount (drops string)', async () => {
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: () => ({ result: { lines: [] } }),
        ripplePathFind: () => ({
          result: {
            alternatives: [
              {
                source_amount: '1000000', // 1 XRP in drops
                paths_computed: [[{ account: ISSUER_A, type: 1 }]],
              },
            ],
          },
        }),
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 50,
        pathFindRetryDelaysMs: [],
      })
      expect(out.sourceAmountCurrency).toBe('XRP')
      expect(out.sourceAmountValue).toBe('1000000')
      // SendMax for XRP source is a drops string, not an object.
      expect(typeof out.SendMax).toBe('string')
      // 1_000_000 drops * 1.005 = 1_005_000
      expect(out.SendMax).toBe('1005000')
    })

    it('throws PAYMENT_PATH_FAILED when no alternatives are returned', async () => {
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: () => ({ result: { lines: [] } }),
        ripplePathFind: () => ({ result: { alternatives: [] } }),
      })
      await expect(
        resolveIouPaymentExtras({
          client,
          sender: SENDER,
          recipient: RECIPIENT,
          destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
          slippageBps: 50,
          pathFindRetryDelaysMs: [],
        }),
      ).rejects.toThrow(/PAYMENT_PATH_FAILED.*No path/)
    })

    it('error message names sender/recipient/currency to be actionable', async () => {
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: () => ({ result: { lines: [] } }),
        ripplePathFind: () => ({ result: { alternatives: [] } }),
      })
      await expect(
        resolveIouPaymentExtras({
          client,
          sender: SENDER,
          recipient: RECIPIENT,
          destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
          slippageBps: 50,
          pathFindRetryDelaysMs: [],
        }),
      ).rejects.toThrow(new RegExp(`${SENDER}.*${RECIPIENT}.*USD.${ISSUER_A}`))
    })

    it('passes source_currencies derived from sender account_lines', async () => {
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: ({ account }: any) => {
          if (account === SENDER) {
            return {
              result: {
                lines: [
                  { currency: 'EUR', account: ISSUER_B, balance: '500' },
                  { currency: 'GBP', account: 'rIssuerC', balance: '0' },
                ],
              },
            }
          }
          return { result: { lines: [] } }
        },
        ripplePathFind: () => ({
          result: {
            alternatives: [
              {
                source_amount: { currency: 'EUR', issuer: ISSUER_B, value: '100' },
                paths_computed: [],
              },
            ],
          },
        }),
      })
      await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 0,
        pathFindRetryDelaysMs: [],
      })
      const pathFindCall = client.request.mock.calls.find(
        (c: any[]) => c[0].command === 'ripple_path_find',
      )
      expect(pathFindCall).toBeDefined()
      expect(pathFindCall[0].source_currencies).toEqual([
        { currency: 'XRP' },
        { currency: 'EUR', issuer: ISSUER_B },
        { currency: 'GBP', issuer: 'rIssuerC' },
      ])
    })
  })

  describe('path-find retries', () => {
    it('retries when the first call returns no alternatives, then succeeds', async () => {
      let calls = 0
      const altSourceAmount = { currency: 'EUR', issuer: ISSUER_B, value: '100' }
      const client = mockClient({
        accountInfo: () => ({ result: { account_data: {} } }),
        accountLines: () => ({ result: { lines: [] } }),
        ripplePathFind: () => {
          calls++
          if (calls < 3) return { result: { alternatives: [] } }
          return {
            result: {
              alternatives: [{ source_amount: altSourceAmount, paths_computed: [] }],
            },
          }
        },
      })
      const out = await resolveIouPaymentExtras({
        client,
        sender: SENDER,
        recipient: RECIPIENT,
        destinationAmount: { currency: 'USD', issuer: ISSUER_A, value: '100' },
        slippageBps: 0,
        // Zero-delay retries: keep the test fast.
        pathFindRetryDelaysMs: [0, 0, 0],
      })
      expect(calls).toBe(3)
      expect(out.strategy).toBe('cross-issuer')
    })
  })

  describe('charge client integration -- slippage validation runs at construction', () => {
    it('throws INVALID_AMOUNT when slippageBps is out of range at charge() factory', async () => {
      const { charge } = await import('../../sdk/src/client/Charge.js')
      const { Wallet } = await import('xrpl')
      const w = Wallet.generate()
      expect(() => charge({ seed: w.seed!, slippageBps: 1500 })).toThrow(/INVALID_AMOUNT/)
      expect(() => charge({ seed: w.seed!, slippageBps: -10 })).toThrow(/INVALID_AMOUNT/)
    })
  })
})
