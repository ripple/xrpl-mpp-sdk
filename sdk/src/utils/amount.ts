/**
 * Exact comparison of ledger amounts.
 *
 * The XRP Ledger rewrites issued-currency values into its own canonical form:
 * a Payment sent for `"1.10"` comes back as `"1.1"`, and `"10.0"` as `"10"`.
 * Comparing the two as strings therefore rejects a payment that settled exactly
 * as challenged. In push mode that costs the payer real money -- the transaction
 * is already on-chain, and its InvoiceID binds it to the challenge just refused,
 * so it cannot be presented again.
 *
 * Drops and MPT base units are integers and are never rewritten, but they are
 * compared the same way here: a challenge may still spell an integer with a
 * leading zero or a trailing `.0`, and there is no reason for that to fail.
 *
 * Deliberately string arithmetic rather than a decimal library. Parsing through
 * a JavaScript number would reintroduce the precision loss this exists to avoid,
 * and the SDK keeps a single runtime dependency.
 */

/** Plain decimal, optional sign, no exponent. What XRPL emits. */
const DECIMAL = /^[+-]?\d*(\.\d*)?$/

/**
 * Canonical form of a decimal string: no sign on zero, no leading zeros, no
 * trailing fractional zeros, no bare trailing point.
 *
 * Returns `null` when the input is not a plain decimal, which the caller must
 * treat as "not comparable" rather than "equal".
 */
export function canonicalDecimal(value: string): string | null {
  if (typeof value !== 'string' || value === '' || !DECIMAL.test(value)) return null

  const negative = value.startsWith('-')
  const unsigned = value.replace(/^[+-]/, '')
  const [rawInt = '', rawFrac = ''] = unsigned.split('.')
  if (rawInt === '' && rawFrac === '') return null

  const intPart = rawInt.replace(/^0+/, '')
  const fracPart = rawFrac.replace(/0+$/, '')

  if (intPart === '' && fracPart === '') return '0'
  const magnitude = fracPart === '' ? intPart || '0' : `${intPart || '0'}.${fracPart}`
  return negative ? `-${magnitude}` : magnitude
}

/**
 * True when both strings denote the same decimal value.
 *
 * Returns `false` when either side is unparseable. An amount the SDK cannot
 * read is not an amount it should accept as matching.
 */
export function sameAmount(a: string, b: string): boolean {
  const left = canonicalDecimal(a)
  if (left === null) return false
  const right = canonicalDecimal(b)
  return right !== null && left === right
}
