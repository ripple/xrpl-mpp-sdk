import { Method } from 'mppx'
import { z } from 'zod/mini'

/**
 * XRPL's total supply is 1e17 drops (18 digits), so nothing legitimate needs
 * more. Bounding the digit count stops a multi-megabyte numeric string from
 * reaching `BigInt`.
 */
const MAX_DROPS_DIGITS = 20

/**
 * A PayChannel claim signature is 64 bytes for ed25519 and at most 72 for a DER
 * secp256k1 signature, so 144 hex characters covers both with room to spare.
 * Without a bound, a 10 MB hex string passes the character-class check in linear
 * time and is then handed to the verifier.
 */
const MAX_SIGNATURE_LENGTH = 144

/** A PayChannel ID is the 32-byte ledger index of the channel object. */
const CHANNEL_ID = /^[0-9A-Fa-f]{64}$/

/** XRPL classic address: base58 with an `r` prefix. */
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/

/**
 * XRPL session intent -- off-chain PayChannel claims (XRP-only, both ed25519
 * and secp256k1).
 *
 * The wire `intent` is the canonical MPP `session` intent (mpp.dev: pay-as-you-go
 * over a payment channel). The underlying mechanism is an XRPL Payment Channel,
 * so the SDK keeps the "channel" name for its own API, exports, and helpers.
 * The server/client wrappers register `alias: 'channel'` so credentials issued
 * against the pre-`session` wire intent still route and verify.
 */
export const channel = Method.from({
  name: 'xrpl',
  intent: 'session',
  schema: {
    credential: {
      payload: z.union([
        z.object({
          action: z.literal('open'),
          /** Signed PaymentChannelCreate tx blob. */
          transaction: z.string(),
          /** Initial cumulative claim amount (drops). */
          amount: z.string().check(z.regex(/^\d+$/), z.maxLength(MAX_DROPS_DIGITS)),
          /** Hex-encoded claim signature for the initial amount. */
          signature: z.string().check(z.regex(/^[0-9a-fA-F]+$/), z.maxLength(MAX_SIGNATURE_LENGTH)),
        }),
        z.object({
          action: z.literal('voucher'),
          channelId: z.string().check(z.regex(CHANNEL_ID)),
          amount: z.string().check(z.regex(/^\d+$/), z.maxLength(MAX_DROPS_DIGITS)),
          signature: z.string().check(z.regex(/^[0-9a-fA-F]+$/), z.maxLength(MAX_SIGNATURE_LENGTH)),
        }),
        z.object({
          action: z.literal('close'),
          channelId: z.string().check(z.regex(CHANNEL_ID)),
          amount: z.string().check(z.regex(/^\d+$/), z.maxLength(MAX_DROPS_DIGITS)),
          signature: z.string().check(z.regex(/^[0-9a-fA-F]+$/), z.maxLength(MAX_SIGNATURE_LENGTH)),
        }),
      ]),
    },
    request: z.object({
      /** Incremental payment amount in drops. */
      amount: z.string().check(z.regex(/^\d+$/), z.maxLength(MAX_DROPS_DIGITS)),
      /**
       * Currency identifier. XRPL PayChannels are XRP-only, so this is always
       * `"XRP"`. Present because the canonical MPP `session` request carries a
       * `currency`; optional here to stay backward-compatible with challenges
       * issued before the field existed.
       */
      currency: z.optional(z.string()),
      /**
       * PayChannel ID (64 hex chars), or `''` on an open-action challenge.
       *
       * The open flow has no channelId to advertise: it does not exist until
       * the `PaymentChannelCreate` is validated and the server extracts it from
       * the transaction metadata. The credential payload, which is what reaches
       * a store key, stays strictly 64 hex.
       */
      channelId: z.union([z.literal(''), z.string().check(z.regex(CHANNEL_ID))]),
      /** Recipient XRPL classic address (r...). */
      recipient: z.string().check(z.regex(CLASSIC_ADDRESS)),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
      /** Merchant-provided reconciliation ID. */
      externalId: z.optional(z.string()),
      /** Method-specific details injected by the server. */
      methodDetails: z.optional(
        z.object({
          /** Server-generated unique tracking ID. */
          reference: z.optional(z.string()),
          /** XRPL network identifier. */
          network: z.optional(z.string()),
          /** Cumulative amount already committed up to this point (drops). */
          cumulativeAmount: z.optional(z.string()),
        }),
      ),
    }),
  },
})
