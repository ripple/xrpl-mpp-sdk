/**
 * Escrow utilities -- internal.
 *
 * Source of truth for every Escrow-related operation. The public Wallet API
 * (`Wallet.createEscrow`, `Wallet.finishEscrow`, `Wallet.cancelEscrow`,
 * `Wallet.listEscrows`, `Wallet.getEscrow`) delegates here.
 *
 * No symbol from this module is re-exported from `sdk/src/index.ts` except
 * the data types declared in `../types.ts` (`EscrowInfo`, `CreateEscrowOptions`,
 * ...) and the public helper {@link generatePreimageCondition}.
 *
 * XRPL terminology mapping (XRPL -> SDK intent):
 * - `EscrowCreate`  -> `createEscrow`
 * - `EscrowFinish`  -> `finishEscrow`
 * - `EscrowCancel`  -> `cancelEscrow`
 *
 * Time conversion: XRPL records `FinishAfter` / `CancelAfter` in *ripple
 * time* (seconds since 2000-01-01 UTC). The SDK accepts `Date`, Unix
 * milliseconds, or ISO-8601 strings on input and surfaces JS `Date`s on
 * output, so consumers never see ripple time.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  type Client,
  hashes,
  rippleTimeToUnixTime,
  unixTimeToRippleTime,
  type Wallet as XrplWallet,
} from 'xrpl'
import { MPP_SOURCE_TAG } from '../constants.js'
import type {
  CreateEscrowOptions,
  CreateEscrowResult,
  EscrowInfo,
  EscrowReference,
  FinishEscrowOptions,
} from '../types.js'
import { readValidatedCloseTimeMs } from './ledger-time.js'
import { assertReserveCovers, getReserveState } from './reserves.js'

// ---------------------------------------------------------------------------
// Crypto-conditions helper (PREIMAGE-SHA-256)
// ---------------------------------------------------------------------------

/**
 * Generate a fresh PREIMAGE-SHA-256 condition + fulfillment pair for use
 * with {@link Wallet.createEscrow} / {@link Wallet.finishEscrow}.
 *
 * Pass the returned `condition` to `createEscrow({ condition })` -- the
 * escrow is then redeemable only by whoever can present the matching
 * `fulfillment` to `finishEscrow({ condition, fulfillment })`.
 *
 * Both fields are uppercase hex strings ready to drop into XRPL
 * transactions. The preimage is 32 cryptographically-random bytes.
 *
 * @example
 * ```ts
 * const { condition, fulfillment } = generatePreimageCondition()
 * await issuer.createEscrow({ destination, amount, condition, finishAfter })
 * // ... later, holder of fulfillment redeems:
 * await finisher.finishEscrow({ owner, sequence, condition, fulfillment })
 * ```
 */
export function generatePreimageCondition(): { condition: string; fulfillment: string } {
  const preimage = randomBytes(32)
  const hash = createHash('sha256').update(preimage).digest()
  // Crypto-conditions PREIMAGE-SHA-256 ASN.1 DER encoding.
  // Condition: A0 25 80 20 <32-byte sha256> 81 01 20  (cost = 32 = 0x20)
  // Fulfillment: A0 22 80 20 <32-byte preimage>
  const condition = `A0258020${hash.toString('hex')}810120`.toUpperCase()
  const fulfillment = `A0228020${preimage.toString('hex')}`.toUpperCase()
  return { condition, fulfillment }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Submit an `EscrowCreate`. Adds one owner object on the creator -- the
 * SDK runs a reserve preflight first so a typed `INSUFFICIENT_RESERVE` /
 * `INSUFFICIENT_BALANCE` is surfaced before we hit the wire.
 *
 * Returns the submission hash, the `Sequence` (needed to finish/cancel),
 * and the `escrowId` (`hashEscrow(owner, sequence)`).
 */
export async function createEscrow(
  client: Client,
  wallet: XrplWallet,
  options: CreateEscrowOptions,
): Promise<CreateEscrowResult> {
  const { destination, amount, finishAfter, cancelAfter, condition, destinationTag, sourceTag } =
    options

  if (finishAfter === undefined && condition === undefined) {
    throw new Error(
      '[INVALID_AMOUNT] EscrowCreate requires at least one of `finishAfter` or `condition`. ' +
        'Without either, the escrow could never be released.',
    )
  }

  const finishAfterRipple =
    finishAfter !== undefined ? toRippleTime(finishAfter, 'finishAfter') : undefined
  const cancelAfterRipple =
    cancelAfter !== undefined ? toRippleTime(cancelAfter, 'cancelAfter') : undefined

  if (
    finishAfterRipple !== undefined &&
    cancelAfterRipple !== undefined &&
    finishAfterRipple >= cancelAfterRipple
  ) {
    throw new Error(
      '[INVALID_AMOUNT] EscrowCreate requires `finishAfter` to be strictly less than ' +
        '`cancelAfter`. Otherwise the escrow can be cancelled before it can be finished.',
    )
  }

  if (typeof amount === 'string' && BigInt(amount) <= 0n) {
    throw new Error(`[INVALID_AMOUNT] EscrowCreate amount must be > 0 drops, got ${amount}.`)
  }

  // XLS-85 (TokenEscrow): a token escrow (IOU or MPT `Amount` object) must
  // always carry an expiration. Without a `CancelAfter` the ledger accepts
  // the EscrowCreate and locks the tokens, but every later EscrowFinish is
  // rejected with `tecNO_PERMISSION` -- the escrow is unfinishable. Reject
  // upfront so callers never lock tokens they cannot release. (XRP escrows
  // are unaffected: they finish fine on `finishAfter` alone.)
  if (typeof amount === 'object' && cancelAfterRipple === undefined) {
    throw new Error(
      '[INVALID_AMOUNT] EscrowCreate for a token escrow (IOU/MPT) requires `cancelAfter`. ' +
        'Per the TokenEscrow amendment a token escrow with no expiration can never be finished ' +
        '(the ledger rejects EscrowFinish with tecNO_PERMISSION). Pass a `cancelAfter` strictly ' +
        'later than `finishAfter`.',
    )
  }

  if (condition !== undefined && !/^[0-9A-Fa-f]+$/.test(condition)) {
    throw new Error('[INVALID_AMOUNT] EscrowCreate `condition` must be a hex string.')
  }

  // Reserve preflight -- EscrowCreate adds 1 owner object on the source.
  // Payment side: only XRP escrows reduce the *available* XRP balance, so
  // we factor in `paymentDrops` only when the amount is a drops string.
  const state = await getReserveState(client, wallet.classicAddress)
  if (!state) {
    throw new Error(
      `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} is not yet funded. ` +
        'Fund it before creating an escrow.',
    )
  }
  const paymentDrops = typeof amount === 'string' ? BigInt(amount) : 0n
  assertReserveCovers({
    account: wallet.classicAddress,
    state,
    addedOwnerObjects: 1,
    paymentDrops,
    kind: 'EscrowCreate',
  })

  const tx: any = {
    TransactionType: 'EscrowCreate',
    Account: wallet.classicAddress,
    Destination: destination,
    Amount: amount as any,
  }
  if (finishAfterRipple !== undefined) tx.FinishAfter = finishAfterRipple
  if (cancelAfterRipple !== undefined) tx.CancelAfter = cancelAfterRipple
  if (condition !== undefined) tx.Condition = condition.toUpperCase()
  if (destinationTag !== undefined) tx.DestinationTag = destinationTag
  // Default the on-chain attribution SourceTag; an explicit sourceTag wins.
  tx.SourceTag = sourceTag ?? MPP_SOURCE_TAG

  const result = await client.submitAndWait(tx, { wallet })
  const meta: any = result.result.meta
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`[ESCROW_FAILED] EscrowCreate failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }

  const submitted: any = result.result.tx_json ?? result.result
  const sequence: number | undefined =
    typeof submitted.Sequence === 'number' ? submitted.Sequence : undefined
  if (sequence === undefined) {
    throw new Error(
      '[ESCROW_FAILED] EscrowCreate succeeded but the resulting Sequence could not be ' +
        'located on the submitted transaction. Cannot derive escrowId for follow-ups.',
    )
  }

  return {
    hash: result.result.hash,
    sequence,
    escrowId: hashes.hashEscrow(wallet.classicAddress, sequence),
  }
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

/**
 * Submit an `EscrowFinish`. Releases the escrow's `Amount` to its
 * `Destination`. Anyone can submit (the submitter pays the fee) so the
 * caller need not be the creator -- but the destination is always the
 * one recorded on the escrow.
 *
 * Pre-flight:
 * - Refuse to submit when the escrow has a `FinishAfter` the latest validated
 *   ledger has not yet closed past. The ledger would reject with
 *   `tecNO_PERMISSION`, but a typed `ESCROW_NOT_READY` early is more
 *   actionable. Judged on the ledger's clock, not the local one, because those
 *   two disagree.
 * - When the escrow has a `Condition`, both `condition` and
 *   `fulfillment` are required. The SDK rejects upfront -- the ledger
 *   would surface `tecCRYPTOCONDITION_ERROR`.
 */
export async function finishEscrow(
  client: Client,
  wallet: XrplWallet,
  options: FinishEscrowOptions,
): Promise<{ hash: string }> {
  const { owner, sequence, condition, fulfillment } = options

  const escrow = await readEscrow(client, owner, sequence)
  if (!escrow) {
    throw new Error(
      `[ESCROW_NOT_FOUND] No escrow at (${owner}, sequence=${sequence}). ` +
        'It may already have been finished or cancelled.',
    )
  }

  if (escrow.FinishAfter !== undefined) {
    const finishAt = rippleTimeToUnixTime(escrow.FinishAfter)
    // The ledger judges FinishAfter against the close time of the ledger the
    // transaction lands in, not against wall clock, and it compares strictly.
    // Reading the local clock here disagrees with it in both directions.
    const ledgerNow = await readValidatedCloseTimeMs(client)
    if (ledgerNow <= finishAt) {
      throw new Error(
        `[ESCROW_NOT_READY] Escrow at (${owner}, sequence=${sequence}) cannot be finished ` +
          `until ${new Date(finishAt).toISOString()} (FinishAfter not yet reached).`,
      )
    }
  }

  if (escrow.Condition !== undefined) {
    if (!condition || !fulfillment) {
      throw new Error(
        `[ESCROW_INVALID_FULFILLMENT] Escrow at (${owner}, sequence=${sequence}) requires a ` +
          'crypto-condition fulfillment. Pass both `condition` and `fulfillment` to finishEscrow.',
      )
    }
    if (escrow.Condition.toUpperCase() !== condition.toUpperCase()) {
      throw new Error(
        `[ESCROW_INVALID_FULFILLMENT] Provided condition does not match the on-chain condition ` +
          `of escrow (${owner}, sequence=${sequence}).`,
      )
    }
  }

  const tx: any = {
    TransactionType: 'EscrowFinish',
    Account: wallet.classicAddress,
    Owner: owner,
    OfferSequence: sequence,
    SourceTag: MPP_SOURCE_TAG,
  }
  if (condition !== undefined) tx.Condition = condition.toUpperCase()
  if (fulfillment !== undefined) tx.Fulfillment = fulfillment.toUpperCase()

  const result = await client.submitAndWait(tx, { wallet })
  const meta: any = result.result.meta
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`[ESCROW_FAILED] EscrowFinish failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }
  return { hash: result.result.hash }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Submit an `EscrowCancel`. Returns the locked amount to the escrow's
 * creator. Anyone can submit -- the funds always flow back to `Owner`.
 *
 * Pre-flight:
 * - Refuse to submit before the latest validated ledger has closed past
 *   `CancelAfter`. The ledger would surface `tecNO_PERMISSION`; a typed
 *   `ESCROW_NOT_READY` early is more actionable.
 * - If the escrow was created with no `CancelAfter` it can never be
 *   cancelled -- we surface that as a permanent `ESCROW_NOT_READY`.
 */
export async function cancelEscrow(
  client: Client,
  wallet: XrplWallet,
  reference: EscrowReference,
): Promise<{ hash: string }> {
  const { owner, sequence } = reference

  const escrow = await readEscrow(client, owner, sequence)
  if (!escrow) {
    throw new Error(
      `[ESCROW_NOT_FOUND] No escrow at (${owner}, sequence=${sequence}). ` +
        'It may already have been finished or cancelled.',
    )
  }

  if (escrow.CancelAfter === undefined) {
    throw new Error(
      `[ESCROW_NOT_READY] Escrow at (${owner}, sequence=${sequence}) has no CancelAfter ` +
        'and can never be cancelled -- it can only be finished.',
    )
  }
  const cancelAt = rippleTimeToUnixTime(escrow.CancelAfter)
  // Same clock as the ledger uses, for the same reason as in finishEscrow.
  const ledgerNow = await readValidatedCloseTimeMs(client)
  if (ledgerNow <= cancelAt) {
    throw new Error(
      `[ESCROW_NOT_READY] Escrow at (${owner}, sequence=${sequence}) cannot be cancelled ` +
        `until ${new Date(cancelAt).toISOString()} (CancelAfter not yet reached).`,
    )
  }

  const tx: any = {
    TransactionType: 'EscrowCancel',
    Account: wallet.classicAddress,
    Owner: owner,
    OfferSequence: sequence,
    SourceTag: MPP_SOURCE_TAG,
  }
  const result = await client.submitAndWait(tx, { wallet })
  const meta: any = result.result.meta
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`[ESCROW_FAILED] EscrowCancel failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }
  return { hash: result.result.hash }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read one escrow by `(owner, sequence)`. Returns null when no such
 * escrow exists on the ledger (already finished, cancelled, or never
 * created). All ripple-time fields are surfaced as JS `Date`s.
 */
export async function getEscrow(
  client: Client,
  reference: EscrowReference,
): Promise<EscrowInfo | null> {
  const raw = await readEscrow(client, reference.owner, reference.sequence)
  if (!raw) return null
  return toEscrowInfo(raw, reference.owner, reference.sequence)
}

/**
 * List every escrow currently owned by `account`. Returns [] when the
 * account is unfunded or has no escrow objects.
 */
export async function listEscrows(client: Client, account: string): Promise<EscrowInfo[]> {
  const objects = await accountEscrows(client, account)
  const out: EscrowInfo[] = []
  for (const o of objects) {
    const sequence = readEscrowSequence(o)
    if (sequence === undefined) continue
    out.push(toEscrowInfo(o, account, sequence))
  }
  return out
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type EscrowLedgerObject = {
  Account: string
  Destination: string
  Amount: any
  CancelAfter?: number
  FinishAfter?: number
  Condition?: string
  DestinationTag?: number
  SourceTag?: number
  PreviousTxnLgrSeq?: number
  // The sequence of the EscrowCreate transaction. Some rippled responses
  // expose it as `OfferSequence` (account_objects), others as
  // `Sequence` (ledger_entry).
  OfferSequence?: number
  Sequence?: number
}

async function readEscrow(
  client: Client,
  owner: string,
  sequence: number,
): Promise<EscrowLedgerObject | null> {
  try {
    const r = await client.request({
      command: 'ledger_entry',
      escrow: { owner, seq: sequence },
    } as any)
    const node = (r.result as any).node
    if (!node) return null
    return node as EscrowLedgerObject
  } catch (err: any) {
    const code = err?.data?.error
    if (code === 'entryNotFound') return null
    // Some older rippled servers don't accept the `escrow` shorthand and
    // expect `index = hashEscrow(owner, sequence)`. Fall back to that.
    if (code === 'unknownOption' || code === 'invalidParams') {
      try {
        const escrowId = hashes.hashEscrow(owner, sequence)
        const r2 = await client.request({ command: 'ledger_entry', index: escrowId } as any)
        const node = (r2.result as any).node
        return node ? (node as EscrowLedgerObject) : null
      } catch (err2: any) {
        if (err2?.data?.error === 'entryNotFound') return null
        throw err2
      }
    }
    throw err
  }
}

async function accountEscrows(client: Client, account: string): Promise<EscrowLedgerObject[]> {
  try {
    const r = await client.request({
      command: 'account_objects',
      account,
      type: 'escrow',
    } as any)
    return ((r.result as any).account_objects ?? []) as EscrowLedgerObject[]
  } catch (err: any) {
    const code = err?.data?.error
    if (code === 'actNotFound') return []
    if (code === 'invalidParams' || code === 'unknownOption') {
      // Older rippled rejects the type filter -- retry without and post-filter.
      const r = await client.request({ command: 'account_objects', account } as any)
      const all = ((r.result as any).account_objects ?? []) as any[]
      return all.filter((o) => o.LedgerEntryType === 'Escrow') as EscrowLedgerObject[]
    }
    throw err
  }
}

function readEscrowSequence(o: EscrowLedgerObject): number | undefined {
  if (typeof o.OfferSequence === 'number') return o.OfferSequence
  if (typeof o.Sequence === 'number') return o.Sequence
  return undefined
}

function toEscrowInfo(o: EscrowLedgerObject, owner: string, sequence: number): EscrowInfo {
  const escrowId = hashes.hashEscrow(owner, sequence)
  return {
    escrowId,
    sequence,
    owner,
    destination: o.Destination,
    amount: o.Amount,
    ...(o.FinishAfter !== undefined
      ? { finishAfter: new Date(rippleTimeToUnixTime(o.FinishAfter)) }
      : {}),
    ...(o.CancelAfter !== undefined
      ? { cancelAfter: new Date(rippleTimeToUnixTime(o.CancelAfter)) }
      : {}),
    ...(o.Condition !== undefined ? { condition: o.Condition } : {}),
    ...(o.DestinationTag !== undefined ? { destinationTag: o.DestinationTag } : {}),
    ...(o.SourceTag !== undefined ? { sourceTag: o.SourceTag } : {}),
  }
}

/**
 * Normalise `Date` / Unix-ms / ISO-8601 input into XRPL ripple time
 * (seconds since 2000-01-01 UTC). Throws a typed `INVALID_AMOUNT` when
 * the input is unparseable or in the past relative to the local clock.
 */
function toRippleTime(input: Date | number | string, field: string): number {
  let unixMs: number
  if (input instanceof Date) {
    unixMs = input.getTime()
  } else if (typeof input === 'number') {
    unixMs = input
  } else {
    const parsed = Date.parse(input)
    if (Number.isNaN(parsed)) {
      throw new Error(
        `[INVALID_AMOUNT] EscrowCreate \`${field}\` could not be parsed as a date: ${input}.`,
      )
    }
    unixMs = parsed
  }
  if (!Number.isFinite(unixMs)) {
    throw new Error(`[INVALID_AMOUNT] EscrowCreate \`${field}\` is not a finite timestamp.`)
  }
  if (unixMs <= Date.now()) {
    throw new Error(
      `[INVALID_AMOUNT] EscrowCreate \`${field}\` must be in the future. Got ${new Date(unixMs).toISOString()}, now is ${new Date().toISOString()}.`,
    )
  }
  return unixTimeToRippleTime(unixMs)
}
