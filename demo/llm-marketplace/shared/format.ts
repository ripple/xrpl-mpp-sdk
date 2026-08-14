/**
 * Render a 402-challenge amount in the unit the marketplace just sent.
 *
 * The challenge carries the pair (amount: string, currency: string) where
 * `currency` is the MPP wire identifier:
 *   - `"XRP"`                            -- native, amount in drops
 *   - `'{"currency":"USD","issuer":"r…"}'` (JSON)     -- IOU
 *   - `'{"mpt_issuance_id":"<64-char hex>"}'` (JSON)  -- MPT
 *
 * The client never assembles these strings; it only ever *parses* them out
 * of the 402 it just received. This helper is the only place that knows
 * how each wire shape should appear in a log line or a settlement box.
 *
 * For XRP we expand `drops -> XRP` so the magnitude is readable. For an
 * IOU we show the symbol *and* the truncated issuer -- on XRPL an IOU
 * is uniquely identified by the (symbol, issuer) pair, so `0.1 RLUSD`
 * alone is ambiguous (anyone can issue an IOU called "RLUSD"). For an
 * MPT we show the issuance id truncated to "head…tail" since the full
 * 64-char hex is unwieldy. If the server hinted a friendly label
 * (e.g. `"CRED"` or `"RLUSD"` instead of a 40-char hex code) we honour
 * it via the `label` arg -- still derived from data the server controls,
 * just not from a client-side price table.
 */
export function formatAmount(amount: string | number, currency: string, label?: string): string {
  const n = typeof amount === 'string' ? amount : String(amount)
  if (currency === 'XRP') {
    const drops = Number(n)
    return `${n} drops (${(drops / 1_000_000).toFixed(6)} XRP)`
  }
  try {
    const parsed = JSON.parse(currency) as Record<string, unknown>
    if (typeof parsed.currency === 'string' && typeof parsed.issuer === 'string') {
      const symbol = label ?? parsed.currency
      const issuer = parsed.issuer
      const shortIssuer = issuer.length > 12 ? `${issuer.slice(0, 6)}…${issuer.slice(-4)}` : issuer
      return `${n} ${symbol} (issuer ${shortIssuer})`
    }
    if (typeof parsed.mpt_issuance_id === 'string') {
      const id = parsed.mpt_issuance_id
      const short = id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
      return `${n} ${label ?? `<MPT ${short}>`}`
    }
  } catch {
    // Not JSON -- fall through to the raw wire identifier.
  }
  return `${n} ${label ?? currency}`
}

/**
 * Decode an XRPL IOU currency code into a human-readable label.
 *
 * XRPL currency codes are either a 3-char ASCII string (used verbatim)
 * or a 40-char hex string for longer codes. RLUSD, for instance, arrives
 * on the wire as `524C555344000000000000000000000000000000` -- the ASCII
 * bytes for "RLUSD" zero-padded to 20 bytes. We decode the hex back to
 * ASCII (stopping at the first null byte) so the client can render a
 * friendly symbol it derived itself from the 402 challenge, with no
 * server-provided label.
 */
export function decodeCurrencyCode(code: string): string {
  if (code.length <= 3) return code
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    let out = ''
    for (let i = 0; i < code.length; i += 2) {
      const byte = parseInt(code.slice(i, i + 2), 16)
      if (byte === 0) break
      out += String.fromCharCode(byte)
    }
    return out || code
  }
  return code
}

/**
 * Just the unit suffix (no quantity). Useful when a caller is already
 * formatting the number themselves and only needs the trailing label
 * -- e.g. "drops", "USD (issuer rXXX…YYYY)", "<MPT abc…1234>".
 */
export function formatUnit(currency: string, label?: string): string {
  if (currency === 'XRP') return 'drops'
  try {
    const parsed = JSON.parse(currency) as Record<string, unknown>
    if (typeof parsed.currency === 'string' && typeof parsed.issuer === 'string') {
      const symbol = label ?? parsed.currency
      const issuer = parsed.issuer
      const shortIssuer = issuer.length > 12 ? `${issuer.slice(0, 6)}…${issuer.slice(-4)}` : issuer
      return `${symbol} (issuer ${shortIssuer})`
    }
    if (typeof parsed.mpt_issuance_id === 'string') {
      const id = parsed.mpt_issuance_id
      const short = id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
      return label ?? `<MPT ${short}>`
    }
  } catch {
    // Not JSON.
  }
  return label ?? currency
}
