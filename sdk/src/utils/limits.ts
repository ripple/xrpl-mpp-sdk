/**
 * Pre-parse input limits.
 *
 * The important distinction: by the time a method's `verify` runs, mppx has
 * already base64-decoded and JSON-parsed the `Authorization: Payment` header and
 * stripped it to the declared schema. A size check at that point measures the
 * stripped result, not what was parsed -- verified experimentally, a credential
 * carrying megabytes of junk fields reaches `verify` as a few hundred bytes.
 *
 * So `maxCredentialSize` on the charge and channel methods is a backstop, not a
 * defence. The only place an oversized header can be rejected before the work is
 * done is in front of mppx: a body/header limit at the reverse proxy, or
 * {@link assertCredentialHeaderSize} in the consumer's own middleware.
 *
 * The per-field bounds in the method schemas (signature 144 chars, blob 8 KB,
 * amount 32 chars, channelId exactly 64) do the rest: they cap what any accepted
 * credential can contain, so the regexes that run over those fields are bounded
 * in both pattern and input length.
 */

/**
 * Default ceiling for an `Authorization: Payment` header, in bytes.
 *
 * A pull-mode credential carries a signed transaction blob, the largest legitimate
 * field, and a Payment encodes to well under a kilobyte. 16 KB leaves generous
 * room for base64 expansion and future fields while staying far below anything
 * that costs real work to parse.
 */
export const DEFAULT_MAX_CREDENTIAL_HEADER_BYTES = 16 * 1024

/**
 * Reject an oversized credential header before anything parses it.
 *
 * Call this in HTTP middleware, ahead of mppx. Returns normally when the header
 * is absent or within budget, so it is safe to run unconditionally on every
 * request.
 *
 * @example
 * ```ts
 * import { assertCredentialHeaderSize } from 'xrpl-mpp-sdk/server'
 *
 * app.use((req, res, next) => {
 *   try {
 *     assertCredentialHeaderSize(req.headers.authorization)
 *     next()
 *   } catch {
 *     res.status(431).end()
 *   }
 * })
 * ```
 */
export function assertCredentialHeaderSize(
  header: string | undefined | null,
  maxBytes: number = DEFAULT_MAX_CREDENTIAL_HEADER_BYTES,
): void {
  if (!header) return
  if (maxBytes <= 0) return

  // Byte length, not character count: the header is base64 and a multi-byte
  // character would otherwise undercount.
  const bytes = Buffer.byteLength(header, 'utf8')
  if (bytes > maxBytes) {
    throw new Error(
      `[xrpl-mpp-sdk] Authorization header is ${bytes} bytes, over the ${maxBytes}-byte limit. ` +
        'Reject it here, before the credential is decoded and parsed: a check inside verify() ' +
        'only sees the parsed and stripped result, so the work has already been done by then.',
    )
  }
}
