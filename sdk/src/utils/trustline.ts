/**
 * Trustline utilities (internal).
 *
 * Source of truth for every trustline-related operation. The public Wallet API
 * ([`Wallet.acceptToken`](./wallet.ts), `Wallet.issue`, etc.) delegates here;
 * so does the auto-setup in `serverCharge`. Free functions taking a `Client`
 * keep the layer testable in isolation and let connection lifecycle stay with
 * the caller.
 *
 * No symbol from this module is re-exported from `sdk/src/index.ts` except the
 * data types (`TrustlineInfo`, `SetTrustlineResult`, ...). The functional API
 * is reached exclusively via the Wallet methods.
 */

import type { Client, Wallet as XrplWallet } from 'xrpl'
import { MPP_SOURCE_TAG } from '../constants.js'
import type { IssuedCurrency } from '../types.js'
import { assertReserveCovers, getReserveState } from './reserves.js'
import { assertIssuerHealth } from './validation.js'

// === Issuer (AccountRoot) flags read via account_info ===

const LSF_DEFAULT_RIPPLE = 0x00800000

// === TrustSet flags ===

/** Issuer authorises this specific trustline (only valid when issuer signs). */
const TF_SET_F_AUTH = 0x00010000
/** Holder marks this trustline non-rippling (recommended for plain holders). */
const TF_SET_NO_RIPPLE = 0x00020000

// === AccountSet flag values (used in SetFlag / ClearFlag) ===

export const ASF_REQUIRE_AUTH = 2
export const ASF_DEFAULT_RIPPLE = 8
/**
 * Required on the issuer for the `TokenEscrow` amendment to allow holders
 * to escrow IOUs of this issuer. Without it, an `EscrowCreate` carrying an
 * IOU `Amount` is rejected with `tecNO_PERMISSION`.
 */
export const ASF_ALLOW_TRUSTLINE_LOCKING = 17

// === Public types (re-exported from sdk/src/index.ts) ===

/**
 * Snapshot of a trustline as the SDK exposes it.
 *
 * Normalised across xrpl.js's `account_lines` peculiarities (`no_ripple_peer`,
 * `freeze_peer`, missing `authorized` when permissioned).
 */
export type TrustlineInfo = {
  /** ISO-like currency code (`USD`) or 40-hex non-standard code. */
  currency: string
  /** Issuer classic address. */
  issuer: string
  /** Current balance (positive = holder owns; negative = holder owes back). */
  balance: string
  /** Maximum balance the holder is willing to hold from this issuer. */
  limit: string
  /** False only when issuer has RequireAuth and has not authorised yet. */
  authorized: boolean
  /** Either side has frozen the line. */
  frozen: boolean
  /** Holder set tfSetNoRipple on the line. */
  noRipple: boolean
}

/**
 * Outcome of `setTrustline`.
 *
 * `pending_authorization` is returned (instead of throwing) when the issuer has
 * RequireAuth and the holder side has been created/updated but the issuer has
 * not yet signed an authorising TrustSet. The holder can already see the line
 * but cannot hold a balance until the issuer authorises.
 */
export type SetTrustlineResult =
  | { status: 'unchanged' }
  | { status: 'created'; hash: string }
  | { status: 'updated'; hash: string }
  | { status: 'pending_authorization'; hash?: string }

/** Options for `setTrustline` / `Wallet.acceptToken`. */
export type SetTrustlineOptions = {
  /** Maximum balance willing to hold. @default '10000' */
  limit?: string
  /** Set the no-ripple flag on the holder side. @default false */
  noRipple?: boolean
}

// ---------------------------------------------------------------------------
// Holder operations
// ---------------------------------------------------------------------------

/**
 * Create or update the holder-side trustline for the given IOU.
 *
 * Idempotent: returns `unchanged` when the existing limit matches and the line
 * is authorised. Returns `pending_authorization` when the issuer has RequireAuth
 * and has not authorised yet -- the line exists on the holder side but cannot
 * receive funds.
 *
 * Pre-flight order:
 * 1. Read existing trustline -- short-circuit if already in the desired state.
 * 2. Verify issuer health (no global freeze, DefaultRipple, detect RequireAuth).
 * 3. Verify reserve coverage when creating a new owner object.
 * 4. Submit the TrustSet.
 */
export async function setTrustline(
  client: Client,
  wallet: XrplWallet,
  currency: IssuedCurrency,
  options: SetTrustlineOptions = {},
): Promise<SetTrustlineResult> {
  const { limit = '10000', noRipple = false } = options
  const existing = await readTrustline(client, wallet.classicAddress, currency)

  const limitMatches = existing?.limit === limit
  const authorised = existing?.authorized !== false
  if (existing && limitMatches && authorised) {
    return { status: 'unchanged' }
  }

  const { requiresAuth } = await assertIssuerHealth(client, currency)

  if (!existing) {
    const state = await getReserveState(client, wallet.classicAddress)
    if (!state) {
      throw new Error(
        `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} is not yet funded. ` +
          'Fund it with at least the base reserve before creating a trustline.',
      )
    }
    assertReserveCovers({
      account: wallet.classicAddress,
      state,
      addedOwnerObjects: 1,
      kind: 'TrustSet',
    })
  }

  // Holder side already created at the right limit, only awaiting issuer auth.
  // Don't resubmit -- caller can poll. We return without a hash since the
  // TrustSet is the issuer's, not ours.
  if (existing && limitMatches && !authorised) {
    return { status: 'pending_authorization' }
  }

  const trustSet: any = {
    TransactionType: 'TrustSet',
    Account: wallet.classicAddress,
    SourceTag: MPP_SOURCE_TAG,
    LimitAmount: {
      currency: currency.currency,
      issuer: currency.issuer,
      value: limit,
    },
  }
  if (noRipple) trustSet.Flags = TF_SET_NO_RIPPLE

  const result = await client.submitAndWait(trustSet, { wallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`[TRUSTLINE_FAILED] TrustSet failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }
  const hash = result.result.hash

  if (requiresAuth) {
    return { status: 'pending_authorization', hash }
  }
  return existing ? { status: 'updated', hash } : { status: 'created', hash }
}

/**
 * Remove the holder-side trustline. Refuses to submit if the line still holds
 * a non-zero balance (the holder must send the balance back to the issuer
 * first).
 *
 * XRPL only deletes a trustline ledger entry when *every* non-default flag
 * is also clear (no `tfSetfAuth`, no `tfSetFreeze`, no `tfSetNoRipple`, ...).
 * When the issuer has already authorised the holder via `tfSetfAuth` -- or
 * when any other non-default flag is set -- a TrustSet with limit=0 succeeds
 * but the line persists at zero. The holder's owner reserve is still locked.
 *
 * The return value distinguishes the two outcomes:
 * - `removed`: the trustline ledger entry is gone, the reserve is freed.
 * - `cleared`: the line is at limit=0 / balance=0 but persists; the holder
 *   still pays the owner reserve until the issuer clears the lingering flag.
 */
export async function removeTrustline(
  client: Client,
  wallet: XrplWallet,
  currency: IssuedCurrency,
): Promise<
  { status: 'absent' } | { status: 'removed'; hash: string } | { status: 'cleared'; hash: string }
> {
  const existing = await readTrustline(client, wallet.classicAddress, currency)
  if (!existing) return { status: 'absent' }

  if (existing.balance !== '0') {
    throw new Error(
      `[TRUSTLINE_HAS_BALANCE] Trustline for ${currency.currency} from issuer ${currency.issuer} ` +
        `still holds a balance of ${existing.balance}. Send the balance back to the issuer ` +
        '(or have it clawed back) before removing the trustline.',
    )
  }

  const trustSet = {
    TransactionType: 'TrustSet' as const,
    Account: wallet.classicAddress,
    SourceTag: MPP_SOURCE_TAG,
    LimitAmount: { currency: currency.currency, issuer: currency.issuer, value: '0' },
  }
  const result = await client.submitAndWait(trustSet, { wallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `[TRUSTLINE_FAILED] TrustSet (remove) failed: ${meta?.TransactionResult ?? 'unknown'}`,
    )
  }
  const hash = result.result.hash

  // Re-read post-submit. If the line still appears, it means a non-default
  // flag (typically tfSetfAuth on a RequireAuth issuer) keeps the entry
  // pinned to the ledger.
  const after = await readTrustline(client, wallet.classicAddress, currency)
  if (after) {
    return { status: 'cleared', hash }
  }
  return { status: 'removed', hash }
}

/** Read one trustline. Returns null if the holder has not created it. */
export async function getTrustline(
  client: Client,
  account: string,
  currency: IssuedCurrency,
): Promise<TrustlineInfo | null> {
  const row = await readTrustline(client, account, currency)
  if (!row) return null
  return {
    currency: row.currency,
    issuer: currency.issuer,
    balance: row.balance,
    limit: row.limit,
    authorized: row.authorized !== false,
    frozen: row.freeze,
    noRipple: row.noRipple,
  }
}

/** List all trustlines on an account. Returns [] if the account is unfunded. */
export async function listTrustlines(client: Client, account: string): Promise<TrustlineInfo[]> {
  try {
    const r = await client.request({ command: 'account_lines', account })
    return (r.result.lines as any[]).map((l) => ({
      currency: l.currency,
      issuer: l.account,
      balance: l.balance,
      limit: l.limit,
      authorized: l.authorized !== false,
      frozen: Boolean(l.freeze ?? l.freeze_peer),
      noRipple: Boolean(l.no_ripple ?? l.no_ripple_peer),
    }))
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return []
    throw err
  }
}

// ---------------------------------------------------------------------------
// Issuer operations
// ---------------------------------------------------------------------------

/**
 * Issuer-side authorisation of a holder trustline (only meaningful when the
 * issuer has RequireAuth set).
 */
export async function authorizeTrustline(
  client: Client,
  issuer: XrplWallet,
  holder: string,
  currency: IssuedCurrency,
): Promise<{ hash: string }> {
  if (currency.issuer !== issuer.classicAddress) {
    throw new Error(
      `[xrpl-mpp-sdk] authorizeTrustline: wallet (${issuer.classicAddress}) does not match ` +
        `currency issuer (${currency.issuer}).`,
    )
  }
  return submitTrustSetAdmin(client, issuer, {
    LimitAmount: {
      currency: currency.currency,
      issuer: holder,
      value: '0',
    },
    Flags: TF_SET_F_AUTH,
  })
}

/** Issuance Payment: issuer credits `to` with `amount` of their own IOU. */
export async function issuePayment(
  client: Client,
  issuer: XrplWallet,
  to: string,
  amount: string,
  currency: IssuedCurrency,
): Promise<{ hash: string }> {
  if (currency.issuer !== issuer.classicAddress) {
    throw new Error(
      `[xrpl-mpp-sdk] issuePayment: wallet (${issuer.classicAddress}) does not match ` +
        `currency issuer (${currency.issuer}).`,
    )
  }
  const payment = {
    TransactionType: 'Payment' as const,
    Account: issuer.classicAddress,
    SourceTag: MPP_SOURCE_TAG,
    Destination: to,
    Amount: {
      currency: currency.currency,
      issuer: issuer.classicAddress,
      value: amount,
    },
  }
  const result = await client.submitAndWait(payment, { wallet: issuer })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `[SUBMISSION_FAILED] Issuance Payment failed: ${meta?.TransactionResult ?? 'unknown'}`,
    )
  }
  return { hash: result.result.hash }
}

/**
 * Toggle an AccountRoot flag (asfDefaultRipple, asfRequireAuth, ...).
 */
export async function setAccountFlag(
  client: Client,
  wallet: XrplWallet,
  asfFlag: number,
  enable: boolean,
): Promise<{ hash: string }> {
  const tx: any = {
    TransactionType: 'AccountSet',
    Account: wallet.classicAddress,
    SourceTag: MPP_SOURCE_TAG,
  }
  if (enable) tx.SetFlag = asfFlag
  else tx.ClearFlag = asfFlag

  const result = await client.submitAndWait(tx, { wallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `[SUBMISSION_FAILED] AccountSet failed: ${meta?.TransactionResult ?? 'unknown'}`,
    )
  }
  return { hash: result.result.hash }
}

// ---------------------------------------------------------------------------
// Backward compat
// ---------------------------------------------------------------------------

/**
 * Legacy helper kept for `serverCharge` autoTrustline. New code should call
 * `setTrustline` directly (or use the public `Wallet.acceptToken`).
 *
 * Throws `MISSING_TRUSTLINE` when the line is missing and `autoTrustline` is
 * false; throws `TRUSTLINE_REQUIRES_AUTH` when the line is created but the
 * issuer must still authorise.
 */
export async function ensureTrustline(params: {
  client: Client
  wallet: XrplWallet
  currency: IssuedCurrency
  autoTrustline: boolean
  trustlineLimit?: string
}): Promise<void> {
  const { client, wallet, currency, autoTrustline, trustlineLimit } = params
  const existing = await readTrustline(client, wallet.classicAddress, currency)
  if (existing && existing.authorized !== false) return

  if (!autoTrustline) {
    throw new Error(
      `[MISSING_TRUSTLINE] No trustline for ${currency.currency} from issuer ${currency.issuer}. ` +
        'Set autoTrustline: true to auto-create, or create a trustline manually.',
    )
  }

  const result = await setTrustline(client, wallet, currency, {
    ...(trustlineLimit ? { limit: trustlineLimit } : {}),
  })

  if (result.status === 'pending_authorization') {
    throw new Error(
      `[TRUSTLINE_REQUIRES_AUTH] Issuer ${currency.issuer} has asfRequireAuth set. ` +
        `The trustline for ${currency.currency} was created but cannot hold balance until the issuer ` +
        'submits a TrustSet with the tfSetfAuth flag against this account.',
    )
  }
}

/**
 * Check if the issuer has the DefaultRipple flag set (lsfDefaultRipple = 0x00800000).
 * Required for IOU payments to work properly.
 */
export async function checkRippling(client: Client, issuer: string): Promise<boolean> {
  try {
    const response = await client.request({
      command: 'account_info',
      account: issuer,
    })
    const flags = response.result.account_data.Flags ?? 0
    return (flags & LSF_DEFAULT_RIPPLE) !== 0
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return false
    throw err
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type TrustlineRow = {
  currency: string
  account: string
  balance: string
  limit: string
  /** false when the issuer has not yet authorized this trustline (RequireAuth). */
  authorized: boolean | undefined
  freeze: boolean
  noRipple: boolean
}

/**
 * Look up the trustline for the given account+issuer+currency. Returns null if
 * no line exists (caller decides whether to create).
 *
 * Note: account_lines normalizes amounts so a "low" account's no_ripple flag
 * surfaces as `no_ripple_peer`. The fields we care about for validation are
 * `authorized`, `freeze`, and balance.
 */
async function readTrustline(
  client: Client,
  account: string,
  currency: IssuedCurrency,
): Promise<TrustlineRow | null> {
  try {
    const r = await client.request({
      command: 'account_lines',
      account,
      peer: currency.issuer,
    })
    const line = (r.result.lines as any[]).find((l) => l.currency === currency.currency)
    if (!line) return null
    return {
      currency: line.currency,
      account: line.account,
      balance: line.balance,
      limit: line.limit,
      authorized: line.authorized,
      freeze: Boolean(line.freeze ?? line.freeze_peer),
      noRipple: Boolean(line.no_ripple ?? line.no_ripple_peer),
    }
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return null
    throw err
  }
}

/**
 * Submit a TrustSet whose payload is a `LimitAmount` + `Flags` admin pair.
 * Used for issuer-side authorize on a holder trustline.
 */
async function submitTrustSetAdmin(
  client: Client,
  wallet: XrplWallet,
  payload: { LimitAmount: { currency: string; issuer: string; value: string }; Flags: number },
): Promise<{ hash: string }> {
  const tx = {
    TransactionType: 'TrustSet' as const,
    Account: wallet.classicAddress,
    SourceTag: MPP_SOURCE_TAG,
    ...payload,
  }
  const result = await client.submitAndWait(tx, { wallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`[TRUSTLINE_FAILED] TrustSet failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }
  return { hash: result.result.hash }
}
