/**
 * Helpers that translate wall-clock challenge expiry into XRPL ledger
 * coordinates, and back. Used by both the client (to cap a transaction's
 * `LastLedgerSequence`) and the server (to reject blobs / validated txs
 * whose `LastLedgerSequence` would let them outlive the challenge).
 *
 * Why this matters: `mppx`'s `challenge.expires` is enforced at the MPP
 * layer (server compares wall-clock now vs `expires` at verify time),
 * but xrpl.js's default `autofill` sets `LastLedgerSequence ≈ current +
 * 4` (~16s). On a slow ledger or with retries, that window can outlive
 * a tight challenge -- giving an attacker who intercepts the signed
 * blob a replay opportunity past the logical expiry.
 */

import { type Client, rippleTimeToUnixTime } from 'xrpl'
import { warnOnce } from './warn.js'

/** XRPL nominal ledger-close interval. Real intervals jitter around this. */
export const LEDGER_CLOSE_INTERVAL_MS = 4_000

/**
 * Slack added to server-side checks: a tx whose `LastLedgerSequence`
 * exceeds the cap by up to this many ledgers is still accepted, to
 * tolerate clock drift between client and server and the ±2s jitter
 * around the nominal ledger close interval.
 */
export const SERVER_SLACK_LEDGERS = 4

/**
 * Read the latest *validated* ledger index from the connected node.
 *
 * Distinct from {@link readCurrentLedgerIndex}, which returns the in-progress
 * ledger. Only a validated ledger is final; anything in the open ledger can
 * still be reordered or dropped.
 */
export async function readValidatedLedgerIndex(client: Client): Promise<number> {
  const r = await client.request({ command: 'server_info' } as any)
  const idx = (r.result as any)?.info?.validated_ledger?.seq
  if (typeof idx !== 'number' || !Number.isFinite(idx)) {
    throw new Error(
      '[SUBMISSION_FAILED] server_info did not report a validated ledger. The node may still be ' +
        'syncing, in which case it cannot be trusted to confirm settlement.',
    )
  }
  return idx
}

/**
 * Read the close time of the latest validated ledger, in Unix milliseconds.
 *
 * This is the clock the ledger itself uses to judge `FinishAfter` and
 * `CancelAfter`: it compares them against the *parent close time* of the ledger
 * a transaction lands in, never against wall clock. A pre-flight that reads the
 * local clock instead disagrees with the ledger in both directions -- refusing an
 * escrow the ledger would accept when the local clock lags, and submitting one it
 * will reject with `tecNO_PERMISSION` when the local clock runs ahead.
 *
 * Close times are whole seconds, so the comparison at the call site has to be
 * strict to match the ledger's own.
 */
export async function readValidatedCloseTimeMs(client: Client): Promise<number> {
  const r = (await client.request({
    command: 'ledger',
    ledger_index: 'validated',
  } as never)) as { result?: { ledger?: { close_time?: number } } }
  const closeTime = r.result?.ledger?.close_time
  if (typeof closeTime !== 'number' || !Number.isFinite(closeTime)) {
    throw new Error(
      '[SUBMISSION_FAILED] the node did not report a close time for the latest validated ledger. ' +
        'It may still be syncing, in which case its view of time cannot be trusted.',
    )
  }
  return rippleTimeToUnixTime(closeTime)
}

/**
 * Assert a transaction is final: reported as validated, and buried under at
 * least `minConfirmations` closed ledgers.
 *
 * `validated: true` alone is the important half -- rippled reports metadata for
 * transactions in the open ledger too, and treating that as settled means
 * granting a paid resource against a result that can still disappear. The depth
 * requirement is defence against a single node reporting a validation its peers
 * have not seen.
 */
export function assertLedgerFinality(params: {
  /** The `validated` flag from the `tx` response. */
  validated: unknown
  /** Ledger the transaction landed in. */
  txLedgerIndex: number | undefined
  /** Latest validated ledger index reported by the node. */
  validatedLedgerIndex: number
  /** Closed ledgers required on top of the transaction's own. */
  minConfirmations: number
  txHash: string
}): void {
  const { validated, txLedgerIndex, validatedLedgerIndex, minConfirmations, txHash } = params

  if (validated !== true) {
    throw new Error(
      `[SUBMISSION_FAILED] Transaction ${txHash} is not in a validated ledger. The node returned ` +
        'metadata from the open ledger, which is not final and can still be reordered or dropped.',
    )
  }

  if (minConfirmations <= 0) return

  if (typeof txLedgerIndex !== 'number') {
    throw new Error(
      `[SUBMISSION_FAILED] Transaction ${txHash} reported no ledger_index, so its confirmation ` +
        'depth cannot be established.',
    )
  }

  const confirmations = validatedLedgerIndex - txLedgerIndex + 1
  if (confirmations < minConfirmations) {
    throw new Error(
      `[SUBMISSION_FAILED] Transaction ${txHash} has ${confirmations} validated-ledger ` +
        `confirmation(s), fewer than the ${minConfirmations} required.`,
    )
  }
}

/** Read the current (in-progress) ledger index from the connected node. */
export async function readCurrentLedgerIndex(client: Client): Promise<number> {
  const r = await client.request({ command: 'ledger_current' } as any)
  const idx = (r.result as any).ledger_current_index
  if (typeof idx !== 'number' || !Number.isFinite(idx)) {
    throw new Error(
      '[SUBMISSION_FAILED] ledger_current did not return a valid ledger_current_index.',
    )
  }
  return idx
}

/**
 * Compute the maximum `LastLedgerSequence` value such that the
 * transaction is forced to expire at or before the given ISO-8601
 * challenge expiry, given the current (in-progress) ledger index.
 *
 * Throws `INVALID_AMOUNT` when `expiresIso` is unparseable, or
 * `SUBMISSION_FAILED` when the challenge is already expired or has
 * less than one ledger interval remaining (no room to land any tx
 * before expiry).
 */
export function lastLedgerSequenceFromExpires(params: {
  currentLedgerIndex: number
  expiresIso: string
  /** Override `Date.now()` -- useful for deterministic tests. */
  nowMs?: number
}): number {
  const { currentLedgerIndex, expiresIso } = params
  const now = params.nowMs ?? Date.now()
  const expiresMs = Date.parse(expiresIso)
  if (Number.isNaN(expiresMs)) {
    throw new Error(
      `[INVALID_AMOUNT] challenge.expires is not a valid ISO-8601 date: ${expiresIso}.`,
    )
  }
  const msUntilExpiry = expiresMs - now
  if (msUntilExpiry <= LEDGER_CLOSE_INTERVAL_MS) {
    throw new Error(
      `[SUBMISSION_FAILED] challenge.expires (${expiresIso}) leaves less than one ledger ` +
        `interval (~${LEDGER_CLOSE_INTERVAL_MS / 1000}s) -- no room to submit a transaction before expiry.`,
    )
  }
  // ceil so we land *at or before* expiry: a fractional remainder counts
  // as a full ledger we can wait for. Cap is current + how many ledger
  // intervals fit before expiry.
  return currentLedgerIndex + Math.ceil(msUntilExpiry / LEDGER_CLOSE_INTERVAL_MS)
}

/**
 * Server-side lower bound on transaction age.
 *
 * `assertTxExpiresWithinChallenge` caps how *late* a transaction may land, but
 * says nothing about how early it settled -- a payment from last week trivially
 * satisfies an upper bound. Push mode presents a hash of an already-validated
 * transaction, so without this a prior unrelated payment can be replayed as
 * proof for a fresh challenge.
 *
 * The floor is derived from `challenge.expires` minus the assumed maximum
 * challenge lifetime, so no extra RPC is needed beyond the `ledger_current` read
 * the expiry check already performs. An mppx challenge carries no issuance
 * timestamp -- `createdAt` does not exist on it -- so `expires` is the only
 * authenticated anchor available.
 */
export function assertTxNotOlderThanChallenge(params: {
  /** `ledger_index` of the validated transaction being presented as proof. */
  txLedgerIndex: number | undefined
  currentLedgerIndex: number
  /** `challenge.expires`, ISO-8601. HMAC-covered, so a client cannot extend it. */
  expiresIso: string
  /** Assumed maximum challenge lifetime, used to derive the issuance floor. */
  maxChallengeLifetime: number
  nowMs?: number
}): void {
  const { txLedgerIndex, currentLedgerIndex, expiresIso, maxChallengeLifetime } = params
  if (txLedgerIndex === undefined) return

  const expiresMs = Date.parse(expiresIso)
  if (Number.isNaN(expiresMs)) return

  // The challenge cannot have been issued earlier than its expiry minus the
  // assumed maximum lifetime. `expires` is the only authenticated timestamp on
  // the challenge, so it is the only sound anchor -- an mppx challenge carries
  // no issuance time at all.
  const issuedNotBefore = expiresMs - maxChallengeLifetime
  const now = params.nowMs ?? Date.now()

  if (issuedNotBefore > now) {
    // The issuer is handing out a longer `expires` window than
    // `maxChallengeLifetime` claims, so this subtraction puts the issuance floor
    // in the future and yields no valid lower bound.
    //
    // Skip rather than reject. Rejecting would deny every legitimate payment on
    // the route -- the floor would sit ahead of any transaction that could
    // possibly exist -- which costs paying clients their funds without making
    // anything safer. Raising `maxChallengeLifetime` to match the window
    // restores the bound, so say so.
    warnOnce(
      'tx-age-floor-inactive',
      '[xrpl-mpp-sdk] the transaction-age floor is inactive: challenges carry an `expires` ' +
        'window longer than maxChallengeLifetime, so no lower bound on issuance can be derived. ' +
        'Raise maxChallengeLifetime to at least the window you issue to re-enable it.',
    )
    return
  }

  const elapsedMs = Math.max(0, now - issuedNotBefore)
  // Ledgers that could have closed since the earliest plausible issuance,
  // rounded up, then relaxed by the usual jitter slack so a fast run of closes
  // cannot reject a legitimate payment.
  const elapsedLedgers = Math.ceil(elapsedMs / LEDGER_CLOSE_INTERVAL_MS)
  const earliestAllowed = currentLedgerIndex - elapsedLedgers - SERVER_SLACK_LEDGERS

  if (txLedgerIndex < earliestAllowed) {
    throw new Error(
      `[SUBMISSION_FAILED] Transaction validated in ledger ${txLedgerIndex}, which predates ` +
        `the challenge window (expires ${expiresIso}, earliest plausible ledger ` +
        `${earliestAllowed}). ` +
        'A payment that settled before the challenge existed cannot be proof for it.',
    )
  }
}

/**
 * Server-side check: assert `txLastLedgerSequence` would not let the
 * transaction land past `challenge.expires` (plus a small ledger-jitter
 * slack). Returns void on success; throws a plain Error tagged
 * `SUBMISSION_FAILED` (callers wrap it into a typed
 * `VerificationFailedError`).
 *
 * No-op when the client did not embed a `LastLedgerSequence` -- the
 * field is technically optional on Payment, but xrpl.js's `autofill`
 * always sets it. Validating only when present keeps us robust to
 * the rare hand-crafted tx.
 */
export function assertTxExpiresWithinChallenge(params: {
  txLastLedgerSequence: number | undefined
  currentLedgerIndex: number
  expiresIso: string
  nowMs?: number
}): void {
  const { txLastLedgerSequence, currentLedgerIndex, expiresIso } = params
  if (txLastLedgerSequence === undefined) return
  const cap = lastLedgerSequenceFromExpires({
    currentLedgerIndex,
    expiresIso,
    ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
  })
  const allowed = cap + SERVER_SLACK_LEDGERS
  if (txLastLedgerSequence > allowed) {
    throw new Error(
      `[SUBMISSION_FAILED] Transaction LastLedgerSequence (${txLastLedgerSequence}) exceeds the ` +
        `cap (${allowed}) derived from challenge.expires (${expiresIso}). The transaction ` +
        'would remain valid past the challenge expiry, which the server rejects to prevent ' +
        'late re-submission of intercepted blobs.',
    )
  }
}
