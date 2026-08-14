/**
 * Strip-mode zod schemas for every untrusted boundary other than the
 * credential.
 *
 * mppx already parses the credential payload against the method schema before
 * `verify` runs, but three boundaries reached security decisions with nothing
 * more than an `as any` cast:
 *
 * - the decoded Payment from a client-supplied blob
 * - responses from an XRPL node (`tx`, `ledger_entry`, `server_info`), which is
 *   the same trust boundary the node-trust guidance covers
 * - values read back from the replay store, which matters more once the store
 *   is shared across processes
 *
 * Explicit `typeof` checks downstream meant most malformed input already failed
 * closed, but "fails closed by accident" is not a control. Parsing at the
 * boundary makes the shape an assertion instead.
 *
 * Strip rather than strict: unknown fields are dropped, never passed through.
 * The ledger gains fields over time (and custom `channelLookup`
 * implementations return supersets), so erroring on unknown keys would break
 * on the next amendment for no security gain -- dropping them already
 * guarantees nothing unexpected reaches the logic.
 */

import { z } from 'zod/mini'

/** XRPL classic address: base58, 25-35 chars, `r` prefix. */
export const ClassicAddress = z
  .string()
  .check(z.regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'not a valid XRPL classic address'))

/** Unsigned integer amount as a decimal string (drops, or token base units). */
export const DropsString = z.string().check(z.regex(/^\d+$/, 'must be an unsigned integer string'))

/** 64-character hex: transaction hashes, channel IDs, InvoiceID. */
export const Hex64 = z.string().check(z.regex(/^[0-9A-Fa-f]{64}$/, 'must be 64 hex characters'))

/** IOU amount object as it appears on a Payment or in `delivered_amount`. */
const IouAmount = z.object({
  currency: z.string(),
  issuer: z.string(),
  value: z.string(),
})

/** MPT amount object. */
const MptAmount = z.object({
  mpt_issuance_id: z.string(),
  value: z.string(),
})

/** Any XRPL amount: drops string, IOU object, or MPT object. */
export const LedgerAmount = z.union([z.string(), IouAmount, MptAmount])

/**
 * Decoded Payment transaction.
 *
 * Deliberately permissive about which optional fields are present -- a
 * hand-crafted transaction may omit `LastLedgerSequence`, and the amount may
 * arrive as `Amount` or `DeliverMax`. What it pins is the type of every field
 * the verifier goes on to compare.
 */
export const PaymentTransaction = z.object({
  TransactionType: z.string(),
  Account: z.string(),
  Destination: z.string(),
  Amount: z.optional(LedgerAmount),
  DeliverMax: z.optional(LedgerAmount),
  Flags: z.optional(z.number()),
  InvoiceID: z.optional(z.string()),
  DestinationTag: z.optional(z.number()),
  SourceTag: z.optional(z.number()),
  LastLedgerSequence: z.optional(z.number()),
  Sequence: z.optional(z.number()),
  ledger_index: z.optional(z.number()),
})

/** Transaction metadata, as far as verification reads it. */
export const TransactionMeta = z.object({
  TransactionResult: z.optional(z.string()),
  delivered_amount: z.optional(LedgerAmount),
})

/**
 * `tx` command response.
 *
 * xrpl.js v4 nests transaction fields under `tx_json`; older shapes flatten
 * them onto the result. Both are accepted and normalised by the caller.
 */
export const TxResponse = z.object({
  validated: z.optional(z.boolean()),
  ledger_index: z.optional(z.number()),
  tx_json: z.optional(PaymentTransaction),
  meta: z.optional(TransactionMeta),
  metaData: z.optional(TransactionMeta),
})

/** Parsed shape of a `tx` response, for callers that pass it around. */
export type TxResponseShape = {
  validated?: boolean | undefined
  ledger_index?: number | undefined
  tx_json?: Record<string, unknown> | undefined
  meta?: { TransactionResult?: string | undefined; delivered_amount?: unknown } | undefined
  metaData?: { TransactionResult?: string | undefined; delivered_amount?: unknown } | undefined
}

/** PayChannel ledger entry, as returned by `ledger_entry`. */
export const PayChannelEntry = z.object({
  Account: ClassicAddress,
  Destination: ClassicAddress,
  Amount: DropsString,
  Balance: z.optional(DropsString),
  PublicKey: z.optional(z.string()),
  SettleDelay: z.optional(z.number()),
  Expiration: z.optional(z.nullable(z.number())),
  CancelAfter: z.optional(z.nullable(z.number())),
})

/**
 * Reserve amount in drops. rippled reports these as integers, but some node
 * versions and proxies emit decimal strings, and `BigInt` accepted both before
 * this schema existed. Accept either rather than tightening a shape the network
 * does not guarantee.
 */
const DropsNumberOrString = z.union([z.number(), DropsString])

/** `server_state` reserve fields, as the preflight reads them. */
export const ServerStateReserves = z.object({
  reserve_base: DropsNumberOrString,
  reserve_inc: DropsNumberOrString,
})

/** `account_info` fields the reserve preflight reads. */
export const AccountInfoData = z.object({
  Balance: z.string(),
  OwnerCount: z.optional(z.number()),
})

/** Persisted channel high-water state. */
export const StoredHighWater = z.object({
  cumulative: DropsString,
  signature: z.string(),
  timestamp: z.optional(z.number()),
})

/** Cached PayChannel metadata. */
export const StoredChannelMeta = z.object({
  account: ClassicAddress,
  destination: ClassicAddress,
  publicKey: z.nullable(z.string()),
  amount: DropsString,
  balance: DropsString,
  settleDelay: z.nullable(z.number()),
  expiration: z.nullable(z.number()),
  cancelAfter: z.nullable(z.number()),
  cachedAt: z.number(),
})

/** Persisted record of an on-chain redemption. */
export const StoredRedeemed = z.object({
  cumulative: DropsString,
  txHash: z.optional(z.string()),
  timestamp: z.optional(z.number()),
})

/**
 * Parse an untrusted value, returning `null` instead of throwing.
 *
 * For store reads and optional ledger fields, a malformed value should be
 * treated as absent -- which fails closed, since callers then re-fetch from the
 * ledger or reject for want of state -- rather than crashing a request path on
 * data written by an older version or by a foreign network sharing the store.
 */
export function parseOrNull<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T | null {
  if (value === null || value === undefined) return null
  const result = schema.safeParse(value)
  return result.success ? (result.data as T) : null
}
