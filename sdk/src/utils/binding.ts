/**
 * Cryptographic binding between a 402 challenge and the on-chain Payment
 * presented as proof for it.
 *
 * Without a binding, the server only checks destination, amount, currency and
 * payer. Any prior payment by the same account with matching terms therefore
 * satisfies any future challenge. Pull mode is incidentally protected -- the
 * server submits the blob itself and an already-settled one fails
 * `tefPAST_SEQ` because its account sequence is consumed -- but push mode
 * presents a hash of an already-validated transaction and has no such
 * protection.
 *
 * `InvoiceID` is the right carrier: it is a fixed 256-bit field, present on
 * XRP, IOU and MPT Payments alike, indexed by rippled, and covered by the
 * transaction signature. `DestinationTag` is only 32 bits, far too small for a
 * nonce, and memos are not a validated field.
 */

import { createHash } from 'node:crypto'

/**
 * Derive the `InvoiceID` that binds a Payment to one specific challenge.
 *
 * SHA-512Half of the challenge id, the same digest convention XRPL uses
 * internally, rendered as the 64 uppercase hex characters `InvoiceID` expects.
 *
 * The challenge id is itself an HMAC over the full challenge contents, so
 * binding to it transitively binds the payment to the amount, recipient,
 * currency and expiry the server issued.
 */
export function challengeInvoiceId(challengeId: string): string {
  return createHash('sha512').update(challengeId, 'utf8').digest('hex').slice(0, 64).toUpperCase()
}

/** True when `value` is a 64-character hex string, the `InvoiceID` shape. */
export function isInvoiceIdShape(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Fa-f]{64}$/.test(value)
}
