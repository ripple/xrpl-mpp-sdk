import { Method } from 'mppx'
import { z } from 'zod/mini'

/**
 * XRPL's total supply is 1e17 drops (18 digits). IOU and MPT values carry a
 * decimal point and an optional exponent, so allow a little more, but not an
 * unbounded string reaching BigInt or the ledger.
 */
const MAX_AMOUNT_LENGTH = 32

/** XRPL classic address: base58 with an `r` prefix. */
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/

/** A signed transaction blob, hex. Well under the 1 KB a Payment encodes to. */
const MAX_BLOB_LENGTH = 8192

/** XRPL charge intent -- on-chain Payment transactions (XRP / IOU / MPT). */
export const charge = Method.from({
  name: 'xrpl',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({
          blob: z.string().check(z.regex(/^[0-9A-Fa-f]+$/), z.maxLength(MAX_BLOB_LENGTH)),
          type: z.literal('transaction'),
        }),
        z.object({
          hash: z.string().check(z.regex(/^[0-9A-Fa-f]{64}$/)),
          type: z.literal('hash'),
        }),
      ]),
    },
    request: z.object({
      /** Payment amount in drops (XRP) or base units (IOU/MPT). */
      amount: z
        .string()
        .check(
          z.minLength(1, 'amount must not be empty'),
          z.maxLength(MAX_AMOUNT_LENGTH),
          z.regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal string'),
        ),
      /** Currency identifier: "XRP", or JSON-encoded IssuedCurrency/MPT. */
      currency: z.string().check(z.minLength(1, 'currency must not be empty')),
      /** Recipient XRPL classic address (r...). */
      recipient: z.string().check(z.regex(CLASSIC_ADDRESS, 'not a valid XRPL classic address')),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
      /** Merchant-provided reconciliation ID. */
      externalId: z.optional(z.string()),
      /** Method-specific details injected by the server. */
      methodDetails: z.optional(
        z.object({
          /** Server-generated unique tracking ID. */
          reference: z.optional(z.string()),
          /** XRPL network identifier ("mainnet" | "testnet" | "devnet"). */
          network: z.optional(z.string()),
          /** Optional InvoiceID (32-byte hex) to bind payment to challenge. */
          invoiceId: z.optional(z.string().check(z.regex(/^[0-9A-Fa-f]{64}$/))),
          /**
           * Optional XRPL DestinationTag the server expects on the inbound
           * Payment. Used by hosted wallets / exchanges to route the
           * incoming credit. When set, the server enforces it on verify.
           */
          destinationTag: z.optional(z.number()),
          /**
           * Optional XRPL SourceTag the server expects -- mirrors
           * destinationTag but on the sender side (rare, but supported for
           * symmetry).
           */
          sourceTag: z.optional(z.number()),
          /**
           * Optional UTF-8 memos to embed in the Payment. Servers can use
           * these for off-chain reconciliation. Each memo is encoded into
           * the tx as a Memos[].Memo entry with hex-encoded fields.
           */
          memos: z.optional(
            z.array(
              z.object({
                type: z.optional(z.string()),
                format: z.optional(z.string()),
                data: z.optional(z.string()),
              }),
            ),
          ),
        }),
      ),
    }),
  },
})

/**
 * Convert XRP to drops.
 *
 * @example
 * ```ts
 * toDrops('1')     // '1000000'
 * toDrops('0.001') // '1000'
 * ```
 */
export function toDrops(xrp: string): string {
  if (xrp.startsWith('-')) {
    return `-${toDrops(xrp.slice(1))}`
  }
  const [whole = '0', frac = ''] = xrp.split('.')
  const paddedFrac = frac.padEnd(6, '0').slice(0, 6)
  return (BigInt(whole) * 1_000_000n + BigInt(paddedFrac)).toString()
}

/**
 * Convert drops to XRP.
 *
 * @example
 * ```ts
 * fromDrops('1000000') // '1.000000'
 * fromDrops('1000')    // '0.001000'
 * ```
 */
export function fromDrops(drops: string): string {
  const bi = BigInt(drops)
  if (bi < 0n) {
    return `-${fromDrops((-bi).toString())}`
  }
  const whole = (bi / 1_000_000n).toString()
  const remainder = (bi % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${remainder}`
}
