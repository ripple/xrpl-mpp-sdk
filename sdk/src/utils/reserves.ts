import type { Client } from 'xrpl'
import { AccountInfoData, parseOrNull, ServerStateReserves } from './schemas.js'

/**
 * Reserve summary for a wallet account.
 *
 * - `base`: base reserve in drops (every funded account requires this).
 * - `inc`: per-owner-object reserve in drops.
 * - `balance`: current XRP balance in drops.
 * - `ownerCount`: number of owner objects currently held.
 *
 * `available` = balance - (base + ownerCount * inc) -- the amount the account
 * can spend or send before hitting the reserve floor.
 */
export type ReserveState = {
  base: bigint
  inc: bigint
  balance: bigint
  ownerCount: number
  available: bigint
}

/**
 * Fetch reserve + balance state for an account in a single round-trip pair
 * (server_state + account_info). Returns null if the account is not yet
 * funded (so the caller can decide whether that is fatal or expected).
 */
export async function getReserveState(
  client: Client,
  account: string,
): Promise<ReserveState | null> {
  const [serverState, info] = await Promise.all([
    client.request({ command: 'server_state' } as any),
    accountInfoOrNull(client, account),
  ])
  // Parse the node's reserve figures: they set the floor the wallet must clear,
  // so a malformed response must fail rather than coerce to NaN via BigInt.
  const validated = parseOrNull(
    ServerStateReserves,
    (serverState.result as { state?: { validated_ledger?: unknown } }).state?.validated_ledger,
  )
  if (!validated) {
    throw new Error('[SUBMISSION_FAILED] Could not retrieve validated ledger state from server.')
  }
  if (!info) return null

  const accountData = parseOrNull(AccountInfoData, info.account_data)
  if (!accountData) {
    throw new Error('[SUBMISSION_FAILED] account_info returned an unexpected account_data shape.')
  }

  const base = BigInt(validated.reserve_base)
  const inc = BigInt(validated.reserve_inc)
  const balance = BigInt(accountData.Balance)
  const ownerCount = accountData.OwnerCount ?? 0
  const totalReserve = base + BigInt(ownerCount) * inc
  const available = balance > totalReserve ? balance - totalReserve : 0n
  return { base, inc, balance, ownerCount, available }
}

async function accountInfoOrNull(
  client: Client,
  account: string,
): Promise<{ account_data: { Balance: string; OwnerCount?: number } } | null> {
  try {
    const r = await client.request({ command: 'account_info', account })
    return r.result as any
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return null
    throw err
  }
}

/** Format drops as XRP (e.g., 1200000 -> "1.2"). */
export function formatDrops(drops: bigint): string {
  const xrp = Number(drops) / 1_000_000
  return xrp.toString()
}

/**
 * Assert that the account can support `addedOwnerObjects` more owner objects
 * plus the given fee + payment delta. Throws an actionable INSUFFICIENT_RESERVE
 * or INSUFFICIENT_BALANCE error otherwise.
 *
 * Rationale: any operation that creates a new owner object (TrustSet,
 * MPTokenAuthorize, PaymentChannelCreate, EscrowCreate, OfferCreate, ...)
 * needs balance >= base + (ownerCount + addedOwnerObjects) * inc + feeDrops
 * + paymentDrops, otherwise the ledger rejects with tecINSUFFICIENT_RESERVE
 * or the account becomes unfunded.
 *
 * `kind` is used in the error message to tell the operator *which* object
 * type triggered the shortfall.
 */
export function assertReserveCovers(params: {
  account: string
  state: ReserveState
  addedOwnerObjects: number
  feeDrops?: bigint
  paymentDrops?: bigint
  kind?: string
}): void {
  const { account, state, addedOwnerObjects, feeDrops = 12n, paymentDrops = 0n, kind } = params
  const targetReserve = state.base + BigInt(state.ownerCount + addedOwnerObjects) * state.inc
  const totalNeeded = targetReserve + feeDrops + paymentDrops
  if (state.balance >= totalNeeded) return

  const code =
    state.balance < state.base + BigInt(state.ownerCount) * state.inc
      ? 'INSUFFICIENT_BALANCE'
      : 'INSUFFICIENT_RESERVE'

  const detail =
    `${kind ? `[${kind}] ` : ''}` +
    `Account ${account} cannot cover the reserve required after the operation. ` +
    `Balance: ${formatDrops(state.balance)} XRP, ` +
    `current reserve: ${formatDrops(state.base + BigInt(state.ownerCount) * state.inc)} XRP ` +
    `(base ${formatDrops(state.base)} + ${state.ownerCount} objects * ${formatDrops(state.inc)}), ` +
    `additional reserve for ${addedOwnerObjects} new owner object${addedOwnerObjects === 1 ? '' : 's'}: ${formatDrops(BigInt(addedOwnerObjects) * state.inc)} XRP, ` +
    `fee: ${formatDrops(feeDrops)} XRP` +
    (paymentDrops > 0n ? `, payment: ${formatDrops(paymentDrops)} XRP` : '') +
    `. Top up to at least ${formatDrops(totalNeeded)} XRP.`

  throw new Error(`[${code}] ${detail}`)
}
