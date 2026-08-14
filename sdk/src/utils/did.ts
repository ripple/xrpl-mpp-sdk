import { deriveAddress, isValidClassicAddress } from 'xrpl'
import { malformedCredential } from '../errors.js'

/**
 * Parse a `did:pkh:xrpl:{network}:{address}` DID string and return the
 * embedded XRPL classic address.
 *
 * The credential `source` field is the issuer DID. Servers must verify that
 * the address embedded in `source` matches the on-chain payer of the
 * transaction. Without this check, an attacker can take a third party's
 * push-mode credential (which contains only a transaction hash) and replay it
 * as their own, claiming credit for someone else's payment ("hash theft").
 *
 * @throws MalformedCredentialError if the source is missing, malformed, or the
 * embedded address is not a valid classic address.
 */
export function classicAddressFromDID(source: unknown): string {
  if (typeof source !== 'string' || source.length === 0) {
    throw malformedCredential('credential source is required to verify the sender address')
  }
  const parts = source.split(':')
  // did : pkh : xrpl : {network} : {address}
  if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'xrpl') {
    throw malformedCredential(
      `credential source has invalid format -- expected did:pkh:xrpl:{network}:{address}, got ${source}`,
    )
  }
  if (!parts[3]) {
    throw malformedCredential('credential source is missing the network segment')
  }
  const address = parts[4]
  if (!isValidClassicAddress(address)) {
    throw malformedCredential(
      `credential source contains an invalid XRPL classic address: ${address}`,
    )
  }
  return address
}

/**
 * Derive the XRPL classic address from a public key.
 * Used to bind channel claim signatures to the credential source DID.
 */
export function classicAddressFromPublicKey(publicKey: string): string {
  return deriveAddress(publicKey)
}
