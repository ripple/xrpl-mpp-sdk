import { describe, expect, it, vi } from 'vitest'
import {
  assertReserveCovers,
  formatDrops,
  getReserveState,
  type ReserveState,
} from '../../sdk/src/utils/reserves.js'
import { assertIssuerHealth } from '../../sdk/src/utils/validation.js'

function mockClient(handlers: Record<string, (params: any) => any>): any {
  return {
    request: vi.fn(async (params: any) => {
      const fn = handlers[params.command]
      if (!fn) {
        throw new Error(`unmocked command: ${params.command}`)
      }
      const result = await fn(params)
      return result
    }),
  }
}

describe('reserves utilities', () => {
  describe('assertReserveCovers', () => {
    const baseState: ReserveState = {
      base: 1_000_000n, // 1 XRP
      inc: 200_000n, // 0.2 XRP
      balance: 5_000_000n, // 5 XRP
      ownerCount: 2,
      available: 5_000_000n - (1_000_000n + 2n * 200_000n), // 3.6 XRP
    }

    it('passes when balance covers reserve + new owner objects + fee + payment', () => {
      expect(() =>
        assertReserveCovers({
          account: 'rTest',
          state: baseState,
          addedOwnerObjects: 1,
          paymentDrops: 1_000_000n,
        }),
      ).not.toThrow()
    })

    it('throws INSUFFICIENT_RESERVE when one extra owner pushes over the line', () => {
      const tight: ReserveState = {
        ...baseState,
        balance: 1_400_000n + 12n, // exactly base + 2*inc + fee, can't fit one more owner
      }
      expect(() =>
        assertReserveCovers({
          account: 'rTest',
          state: tight,
          addedOwnerObjects: 1,
        }),
      ).toThrow(/INSUFFICIENT_RESERVE.*new owner object/)
    })

    it('throws INSUFFICIENT_BALANCE when balance is below current reserve floor', () => {
      const broke: ReserveState = {
        ...baseState,
        balance: 1_000_000n, // below current reserve floor of 1.4 XRP
      }
      expect(() =>
        assertReserveCovers({
          account: 'rTest',
          state: broke,
          addedOwnerObjects: 0,
          paymentDrops: 100n,
        }),
      ).toThrow(/INSUFFICIENT_BALANCE/)
    })

    it('error mentions the operation kind', () => {
      const tight: ReserveState = { ...baseState, balance: 1_400_000n }
      expect(() =>
        assertReserveCovers({
          account: 'rTest',
          state: tight,
          addedOwnerObjects: 1,
          kind: 'TrustSet',
        }),
      ).toThrow(/TrustSet/)
    })
  })

  describe('formatDrops', () => {
    it('formats round XRP', () => {
      expect(formatDrops(1_000_000n)).toBe('1')
      expect(formatDrops(2_500_000n)).toBe('2.5')
    })

    it('formats sub-XRP amounts', () => {
      expect(formatDrops(12n)).toBe('0.000012')
    })
  })

  describe('getReserveState', () => {
    it('returns null when account does not exist', async () => {
      const client = mockClient({
        server_state: () => ({
          result: {
            state: { validated_ledger: { reserve_base: '1000000', reserve_inc: '200000' } },
          },
        }),
        account_info: () => {
          const err: any = new Error('actNotFound')
          err.data = { error: 'actNotFound' }
          throw err
        },
      })
      expect(await getReserveState(client, 'rGone')).toBeNull()
    })

    it('returns balance/owner/reserve when account exists', async () => {
      const client = mockClient({
        server_state: () => ({
          result: {
            state: { validated_ledger: { reserve_base: '1000000', reserve_inc: '200000' } },
          },
        }),
        account_info: () => ({
          result: { account_data: { Balance: '5000000', OwnerCount: 3 } },
        }),
      })
      const state = await getReserveState(client, 'rOK')
      expect(state).not.toBeNull()
      expect(state!.base).toBe(1_000_000n)
      expect(state!.inc).toBe(200_000n)
      expect(state!.balance).toBe(5_000_000n)
      expect(state!.ownerCount).toBe(3)
      expect(state!.available).toBe(5_000_000n - (1_000_000n + 3n * 200_000n))
    })
  })
})

describe('assertIssuerHealth', () => {
  const issuer = 'rIssuer'
  const currency = { currency: 'USD', issuer }

  it('passes when issuer has DefaultRipple set and no global freeze', async () => {
    const client = mockClient({
      account_info: () => ({ result: { account_data: { Flags: 0x00800000 } } }),
    })
    const out = await assertIssuerHealth(client, currency)
    expect(out.requiresAuth).toBe(false)
  })

  it('detects RequireAuth (asfRequireAuth)', async () => {
    const client = mockClient({
      account_info: () => ({
        result: { account_data: { Flags: 0x00800000 | 0x00040000 } },
      }),
    })
    const out = await assertIssuerHealth(client, currency)
    expect(out.requiresAuth).toBe(true)
  })

  it('throws ISSUER_GLOBAL_FROZEN when issuer has lsfGlobalFreeze', async () => {
    const client = mockClient({
      account_info: () => ({
        result: { account_data: { Flags: 0x00800000 | 0x00400000 } },
      }),
    })
    await expect(assertIssuerHealth(client, currency)).rejects.toThrow(/ISSUER_GLOBAL_FROZEN/)
  })

  it('throws PAYMENT_PATH_FAILED when DefaultRipple is missing', async () => {
    const client = mockClient({
      account_info: () => ({ result: { account_data: { Flags: 0 } } }),
    })
    await expect(assertIssuerHealth(client, currency)).rejects.toThrow(/PAYMENT_PATH_FAILED/)
  })

  it('treats missing issuer as no flags (no DefaultRipple) -> PAYMENT_PATH_FAILED', async () => {
    const client = mockClient({
      account_info: () => {
        const err: any = new Error('actNotFound')
        err.data = { error: 'actNotFound' }
        throw err
      },
    })
    await expect(assertIssuerHealth(client, currency)).rejects.toThrow(/PAYMENT_PATH_FAILED/)
  })
})
