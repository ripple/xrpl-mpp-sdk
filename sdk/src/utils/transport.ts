/**
 * Transport validation for the XRPL WebSocket endpoint.
 *
 * Every shipped endpoint in `constants.ts` is `wss://`, and Node verifies
 * certificates for `wss` by default, but `rpcUrl` is a free-form override with
 * no scheme check. A consumer could pass `ws://` and connect in plaintext with
 * no warning: verification traffic, transaction blobs and settlement results
 * would all be readable and modifiable in transit, which is the same trust
 * problem as a hostile node.
 */

/** Schemes that carry TLS. XRPL WebSocket endpoints use `wss:`. */
const SECURE_SCHEMES = new Set(['wss:', 'https:'])

/** Hosts where plaintext is a local rippled or a test double, never the network. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Reject an RPC URL that would connect without TLS.
 *
 * Loopback is allowed unconditionally: a `ws://localhost:6006` rippled in a
 * test or dev container has no transit to protect, and forcing an opt-out there
 * would push people towards setting the flag globally.
 */
export function assertSecureRpcUrl(parameters: {
  rpcUrl: string
  allowInsecureTransport: boolean
  context: string
}): void {
  const { rpcUrl, allowInsecureTransport, context } = parameters

  let url: URL
  try {
    url = new URL(rpcUrl)
  } catch {
    throw new Error(`[xrpl-mpp-sdk] ${context}: rpcUrl is not a valid URL: ${rpcUrl}`)
  }

  if (SECURE_SCHEMES.has(url.protocol)) return
  if (LOOPBACK_HOSTS.has(url.hostname)) return
  if (allowInsecureTransport) return

  throw new Error(
    `[xrpl-mpp-sdk] ${context}: rpcUrl uses ${url.protocol}//, which is not encrypted. ` +
      'Payment verification depends on this connection, so a plaintext transport lets an ' +
      'on-path attacker read and rewrite settlement results. Use wss:// (TLS 1.2 or later), ' +
      'or pass allowInsecureTransport: true for a loopback rippled in development.',
  )
}
