import { describe, expect, it } from 'vitest'
import { channel as channelMethod } from '../../sdk/src/channel/Methods.js'
import { charge as chargeMethod } from '../../sdk/src/Methods.js'
import {
  AccountInfoData,
  ClassicAddress,
  DropsString,
  PayChannelEntry,
  PaymentTransaction,
  parseOrNull,
  ServerStateReserves,
  StoredChannelMeta,
  StoredHighWater,
  StoredRedeemed,
  TxResponse,
} from '../../sdk/src/utils/schemas.js'

const ADDRESS = 'rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC'
const HEX64 = 'AB'.repeat(32)

describe('trust boundary schemas', () => {
  describe('primitives', () => {
    it('accepts a well-formed classic address', () => {
      expect(ClassicAddress.safeParse(ADDRESS).success).toBe(true)
    })

    it('rejects addresses containing non-base58 characters', () => {
      // 0, O, I and l are absent from XRPL's base58 alphabet.
      for (const bad of ['rN7bRFgBrNZKoY2uu015bdjah11UbRZY', 'rO0Il', 'notanaddress', '']) {
        expect(ClassicAddress.safeParse(bad).success).toBe(false)
      }
    })

    it('rejects amounts that are not unsigned integer strings', () => {
      for (const bad of ['-1', '1.5', '1e9', '', 'abc', ' 1']) {
        expect(DropsString.safeParse(bad).success).toBe(false)
      }
      expect(DropsString.safeParse('0').success).toBe(true)
      expect(DropsString.safeParse('100000000000000000').success).toBe(true)
    })
  })

  describe('decoded Payment boundary', () => {
    const valid = {
      TransactionType: 'Payment',
      Account: ADDRESS,
      Destination: ADDRESS,
      Amount: '1000000',
    }

    it('accepts a minimal Payment', () => {
      expect(PaymentTransaction.safeParse(valid).success).toBe(true)
    })

    it('accepts IOU and MPT amount objects', () => {
      expect(
        PaymentTransaction.safeParse({
          ...valid,
          Amount: { currency: 'USD', issuer: ADDRESS, value: '1.5' },
        }).success,
      ).toBe(true)
      expect(
        PaymentTransaction.safeParse({
          ...valid,
          Amount: { mpt_issuance_id: HEX64, value: '10' },
        }).success,
      ).toBe(true)
    })

    it('rejects a Payment with a type-confused Flags field', () => {
      // Flags is bit-tested for tfPartialPayment; a string would silently
      // defeat the mask.
      expect(PaymentTransaction.safeParse({ ...valid, Flags: '131072' }).success).toBe(false)
    })

    it('rejects a Payment with a type-confused DestinationTag', () => {
      expect(PaymentTransaction.safeParse({ ...valid, DestinationTag: '123' }).success).toBe(false)
    })

    it('rejects a Payment missing Account or Destination', () => {
      expect(PaymentTransaction.safeParse({ TransactionType: 'Payment' }).success).toBe(false)
    })

    it('strips unknown fields rather than passing them through', () => {
      const parsed = PaymentTransaction.parse({ ...valid, SomeFutureField: 'x' })
      expect(parsed).not.toHaveProperty('SomeFutureField')
      expect(parsed.Account).toBe(ADDRESS)
    })
  })

  describe('tx response boundary', () => {
    it('accepts a validated response', () => {
      expect(
        TxResponse.safeParse({
          validated: true,
          ledger_index: 1000,
          meta: { TransactionResult: 'tesSUCCESS' },
        }).success,
      ).toBe(true)
    })

    it('rejects a non-boolean validated flag', () => {
      // A node answering "true" as a string must not reach the finality check.
      expect(TxResponse.safeParse({ validated: 'true' }).success).toBe(false)
    })

    it('rejects a non-numeric ledger_index', () => {
      expect(TxResponse.safeParse({ validated: true, ledger_index: '1000' }).success).toBe(false)
    })
  })

  describe('ledger_entry boundary', () => {
    const valid = {
      Account: ADDRESS,
      Destination: ADDRESS,
      Amount: '1000000',
      Balance: '0',
      PublicKey: `ED${'00'.repeat(32)}`,
      SettleDelay: 3600,
    }

    it('accepts a well-formed PayChannel entry', () => {
      expect(PayChannelEntry.safeParse(valid).success).toBe(true)
    })

    it('rejects an entry whose Destination is not an address', () => {
      expect(PayChannelEntry.safeParse({ ...valid, Destination: 'nope' }).success).toBe(false)
    })

    it('rejects an entry whose Amount is not drops', () => {
      expect(PayChannelEntry.safeParse({ ...valid, Amount: '1.5' }).success).toBe(false)
    })

    it('rejects an entry missing Destination entirely', () => {
      const { Destination: _omitted, ...withoutDestination } = valid
      expect(PayChannelEntry.safeParse(withoutDestination).success).toBe(false)
    })
  })

  describe('store read boundary', () => {
    it('accepts well-formed persisted state', () => {
      expect(
        parseOrNull(StoredHighWater, { cumulative: '100', signature: 'AB', timestamp: 1 }),
      ).not.toBeNull()
      expect(parseOrNull(StoredRedeemed, { cumulative: '100' })).not.toBeNull()
    })

    it('treats a malformed high-water record as absent', () => {
      // Fails closed: callers see no prior state rather than crashing or, worse,
      // coercing a bad cumulative into BigInt.
      expect(
        parseOrNull(StoredHighWater, { cumulative: 'not-a-number', signature: 'AB' }),
      ).toBeNull()
      expect(parseOrNull(StoredHighWater, { signature: 'AB' })).toBeNull()
      expect(parseOrNull(StoredHighWater, 'a string')).toBeNull()
    })

    it('treats null and undefined as absent', () => {
      expect(parseOrNull(StoredHighWater, null)).toBeNull()
      expect(parseOrNull(StoredHighWater, undefined)).toBeNull()
    })

    it('treats a malformed metadata cache entry as a cache miss', () => {
      expect(parseOrNull(StoredChannelMeta, { amount: '1', cachedAt: 1 })).toBeNull()
    })
  })

  describe('server_state boundary', () => {
    it('accepts reserves as numbers or decimal strings', () => {
      expect(
        parseOrNull(ServerStateReserves, { reserve_base: 1_000_000, reserve_inc: 200_000 }),
      ).not.toBeNull()
      expect(
        parseOrNull(ServerStateReserves, { reserve_base: '1000000', reserve_inc: '200000' }),
      ).not.toBeNull()
    })

    it('rejects non-numeric reserves', () => {
      expect(
        parseOrNull(ServerStateReserves, { reserve_base: 'lots', reserve_inc: '1' }),
      ).toBeNull()
    })

    it('requires a string Balance on account_data', () => {
      expect(parseOrNull(AccountInfoData, { Balance: 1000 })).toBeNull()
      expect(parseOrNull(AccountInfoData, { Balance: '1000' })).not.toBeNull()
    })
  })

  describe('method schema constraints', () => {
    const payload = channelMethod.schema.credential.payload
    const validVoucher = {
      action: 'voucher' as const,
      channelId: HEX64,
      amount: '1000',
      signature: 'AB'.repeat(32),
    }

    it('accepts a well-formed voucher', () => {
      expect(payload.safeParse(validVoucher).success).toBe(true)
    })

    it('rejects a channelId that is not 64 hex characters', () => {
      // channelId is interpolated into store keys, so an unconstrained value is
      // a key-injection surface.
      for (const bad of ['short', `meta:${HEX64}`, `${HEX64}AA`, 'Z'.repeat(64)]) {
        expect(payload.safeParse({ ...validVoucher, channelId: bad }).success).toBe(false)
      }
    })

    it('rejects an oversized signature', () => {
      const huge = 'A'.repeat(10_000)
      expect(payload.safeParse({ ...validVoucher, signature: huge }).success).toBe(false)
    })

    it('rejects an oversized amount', () => {
      const huge = '9'.repeat(1000)
      expect(payload.safeParse({ ...validVoucher, amount: huge }).success).toBe(false)
    })

    it('constrains the charge request recipient to a classic address', () => {
      const request = chargeMethod.schema.request
      const base = { amount: '1000', currency: 'XRP', recipient: ADDRESS }
      expect(request.safeParse(base).success).toBe(true)
      expect(request.safeParse({ ...base, recipient: 'rNotAnAddress' }).success).toBe(false)
    })

    it('constrains the charge request amount to a decimal string', () => {
      const request = chargeMethod.schema.request
      const base = { amount: '1000', currency: 'XRP', recipient: ADDRESS }
      expect(request.safeParse({ ...base, amount: '1.5' }).success).toBe(true)
      for (const bad of ['-1', 'abc', '1e9', '9'.repeat(64)]) {
        expect(request.safeParse({ ...base, amount: bad }).success).toBe(false)
      }
    })

    it('constrains the charge credential blob and hash', () => {
      const credential = chargeMethod.schema.credential.payload
      expect(credential.safeParse({ type: 'transaction', blob: 'DEADBEEF' }).success).toBe(true)
      expect(credential.safeParse({ type: 'transaction', blob: 'not hex' }).success).toBe(false)
      expect(credential.safeParse({ type: 'transaction', blob: 'A'.repeat(20_000) }).success).toBe(
        false,
      )
      expect(credential.safeParse({ type: 'hash', hash: HEX64 }).success).toBe(true)
      expect(credential.safeParse({ type: 'hash', hash: 'ABC123' }).success).toBe(false)
    })
  })
})
