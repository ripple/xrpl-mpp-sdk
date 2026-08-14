/**
 * MPT (Multi-Purpose Token) utilities -- internal.
 *
 * Source of truth for every MPT-related operation. The public Wallet API
 * (`Wallet.acceptToken`, `Wallet.createToken`, `Wallet.issue`, ...) delegates
 * here when the currency argument is an {@link MPToken}; so does the
 * auto-MPT-authorize path inside `serverCharge`.
 *
 * No symbol from this module is re-exported from `sdk/src/index.ts` except
 * the data types (`MPTHoldingInfo`, `MPTIssuanceInfo`, ...) declared in
 * `../types.ts`. The functional API is reached exclusively via Wallet methods.
 *
 * MPT-specific terminology mapping (XRPL -> SDK intent):
 * - `MPTokenIssuanceCreate` -> `createToken`
 * - `MPTokenAuthorize` (holder, no flags) -> `acceptToken`
 * - `MPTokenAuthorize` (holder, tfMPTUnauthorize) -> `refuseToken`
 * - `MPTokenAuthorize` (issuer, with `Holder`) -> `authorize`
 */

import type { Client, Wallet as XrplWallet } from 'xrpl'
import { MPP_SOURCE_TAG } from '../constants.js'
import type {
  CreateTokenOptions,
  CreateTokenResult,
  MPTHoldingInfo,
  MPTIssuanceInfo,
  MPToken,
} from '../types.js'
import { assertReserveCovers, getReserveState } from './reserves.js'

// ---------------------------------------------------------------------------
// Flag constants (single source of truth -- kept in sync with xrpl.js)
// ---------------------------------------------------------------------------

/** MPTokenIssuanceCreate transaction flags. Persisted on the issuance ledger entry. */
const TF_MPT_CAN_LOCK = 0x00000002
const TF_MPT_REQUIRE_AUTH = 0x00000004
const TF_MPT_CAN_ESCROW = 0x00000008
const TF_MPT_CAN_TRADE = 0x00000010
const TF_MPT_CAN_TRANSFER = 0x00000020
const TF_MPT_CAN_CLAWBACK = 0x00000040

/** MPTokenAuthorize transaction flags. */
const TF_MPT_UNAUTHORIZE = 0x00000001

/** Ledger flags on the MPTokenIssuance entry. */
const LSF_ISSUANCE_LOCKED = 0x00000001
const LSF_ISSUANCE_CAN_LOCK = TF_MPT_CAN_LOCK
const LSF_ISSUANCE_REQUIRE_AUTH = TF_MPT_REQUIRE_AUTH
const LSF_ISSUANCE_CAN_ESCROW = TF_MPT_CAN_ESCROW
const LSF_ISSUANCE_CAN_TRADE = TF_MPT_CAN_TRADE
const LSF_ISSUANCE_CAN_TRANSFER = TF_MPT_CAN_TRANSFER
const LSF_ISSUANCE_CAN_CLAWBACK = TF_MPT_CAN_CLAWBACK

/** Ledger flags on the MPToken entry (holder side). */
const LSF_HOLDING_LOCKED = 0x00000001
const LSF_HOLDING_AUTHORIZED = 0x00000002

const MAX_MPT_METADATA_BYTES = 1024
const MAX_TRANSFER_FEE = 50000
const PROTOCOL_MAX_AMOUNT = '9223372036854775807'

// ---------------------------------------------------------------------------
// Holder operations
// ---------------------------------------------------------------------------

/**
 * Submit (or short-circuit) a holder-side `MPTokenAuthorize` for the given
 * MPT. Idempotent: returns `unchanged` when the MPToken entry already exists
 * and is authorised. Returns `pending_authorization` when the issuance has
 * `requireAuthorization` and the issuer has not signed the paired
 * `MPTokenAuthorize` against this account.
 *
 * Pre-flight order:
 * 1. Look up the MPTokenIssuance to fail fast if it does not exist on-chain.
 * 2. Look up the holder's MPToken entry to short-circuit / detect pending auth.
 * 3. Reserve check before submit (each MPToken adds 1 owner object).
 * 4. Submit the MPTokenAuthorize.
 */
export async function setMPTHolding(
  client: Client,
  wallet: XrplWallet,
  mpt: MPToken,
): Promise<
  | { status: 'unchanged' }
  | { status: 'created'; hash: string }
  | { status: 'pending_authorization'; hash?: string }
> {
  const issuance = await readIssuance(client, mpt.mpt_issuance_id)
  if (!issuance) {
    throw new Error(
      `[MPT_ISSUANCE_NOT_FOUND] MPTokenIssuance ${mpt.mpt_issuance_id} does not exist on the ledger.`,
    )
  }
  const requiresAuth = (issuance.Flags & LSF_ISSUANCE_REQUIRE_AUTH) !== 0

  const existing = await readHoldingRaw(client, wallet.classicAddress, mpt.mpt_issuance_id)
  if (existing) {
    if (!requiresAuth) return { status: 'unchanged' }
    const issuerAuthorized = (existing.flags & LSF_HOLDING_AUTHORIZED) !== 0
    return issuerAuthorized ? { status: 'unchanged' } : { status: 'pending_authorization' }
  }

  const state = await getReserveState(client, wallet.classicAddress)
  if (!state) {
    throw new Error(
      `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} is not yet funded. ` +
        'Fund it before authorising an MPT.',
    )
  }
  assertReserveCovers({
    account: wallet.classicAddress,
    state,
    addedOwnerObjects: 1,
    kind: 'MPTokenAuthorize',
  })

  const tx: any = {
    TransactionType: 'MPTokenAuthorize',
    Account: wallet.classicAddress,
    MPTokenIssuanceID: mpt.mpt_issuance_id,
  }
  const hash = await submitOrThrow(client, wallet, tx, 'MPT_AUTHORIZE_FAILED')

  if (requiresAuth) return { status: 'pending_authorization', hash }
  return { status: 'created', hash }
}

/**
 * Holder-side `MPTokenAuthorize { tfMPTUnauthorize }`: deletes the holder's
 * MPToken entry and frees its owner reserve.
 *
 * Refuses to submit if the entry still holds a non-zero balance -- the
 * holder must send the balance back to the issuer (or have it clawed back)
 * before unauthorising.
 *
 * Returns `absent` when no MPToken entry exists (no-op).
 */
export async function removeMPTHolding(
  client: Client,
  wallet: XrplWallet,
  mpt: MPToken,
): Promise<{ status: 'absent' } | { status: 'removed'; hash: string }> {
  const existing = await readHoldingRaw(client, wallet.classicAddress, mpt.mpt_issuance_id)
  if (!existing) return { status: 'absent' }

  if (existing.balance !== '0') {
    throw new Error(
      `[MPT_HAS_BALANCE] MPToken ${mpt.mpt_issuance_id} on account ${wallet.classicAddress} ` +
        `still holds ${existing.balance} units. Send the balance back to the issuer ` +
        '(or have it clawed back) before refusing the token.',
    )
  }

  const tx: any = {
    TransactionType: 'MPTokenAuthorize',
    Account: wallet.classicAddress,
    MPTokenIssuanceID: mpt.mpt_issuance_id,
    Flags: TF_MPT_UNAUTHORIZE,
  }
  const hash = await submitOrThrow(client, wallet, tx, 'MPT_AUTHORIZE_FAILED')
  return { status: 'removed', hash }
}

/**
 * Read one MPT holding for an account. Returns null when the holder has not
 * created the MPToken entry. The `authorized` field accounts for the
 * issuance's `requireAuthorization` flag: it's `true` whenever the holder
 * can hold a balance, regardless of whether the issuance has an allowlist.
 */
export async function getMPTHolding(
  client: Client,
  account: string,
  mpt: MPToken,
): Promise<MPTHoldingInfo | null> {
  const raw = await readHoldingRaw(client, account, mpt.mpt_issuance_id)
  if (!raw) return null
  const issuance = await readIssuance(client, mpt.mpt_issuance_id)
  return resolveHolding(raw, issuance)
}

/**
 * List every MPT this account currently holds. Performs one
 * `account_objects` call plus one `ledger_entry` lookup per distinct
 * issuance to compute `authorized` correctly.
 */
export async function listMPTHoldings(client: Client, account: string): Promise<MPTHoldingInfo[]> {
  const objects = await accountObjects(client, account, 'mptoken')
  const raw = objects.map(toRawHolding).filter((h): h is RawHolding => h !== null)
  const issuances = await Promise.all(raw.map((r) => readIssuance(client, r.mpt_issuance_id)))
  return raw.map((r, i) => resolveHolding(r, issuances[i] ?? null))
}

// ---------------------------------------------------------------------------
// Issuer operations
// ---------------------------------------------------------------------------

/**
 * Submit `MPTokenIssuanceCreate` and return the resulting `mpt_issuance_id`.
 *
 * The id is read out of the transaction metadata first (xrpl.js >= 4 surfaces
 * it as `mpt_issuance_id` on the meta payload) with a fallback to scanning
 * the issuer's owner objects for the freshly created issuance.
 */
export async function createMPTIssuance(
  client: Client,
  issuer: XrplWallet,
  options: CreateTokenOptions = {},
): Promise<CreateTokenResult> {
  const { transferFee, allowTransfer = true } = options
  if (transferFee !== undefined) {
    if (transferFee < 0 || transferFee > MAX_TRANSFER_FEE) {
      throw new Error(
        `[INVALID_AMOUNT] transferFee must be between 0 and ${MAX_TRANSFER_FEE} ` +
          `(got ${transferFee}).`,
      )
    }
    if (!allowTransfer) {
      throw new Error('[INVALID_AMOUNT] transferFee can only be set when allowTransfer is true.')
    }
  }

  const state = await getReserveState(client, issuer.classicAddress)
  if (!state) {
    throw new Error(
      `[INSUFFICIENT_BALANCE] Account ${issuer.classicAddress} is not yet funded. ` +
        'Fund it before creating an MPT issuance.',
    )
  }
  assertReserveCovers({
    account: issuer.classicAddress,
    state,
    addedOwnerObjects: 1,
    kind: 'MPTokenIssuanceCreate',
  })

  const flags = buildCreateFlags(options)
  const tx: any = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: issuer.classicAddress,
    SourceTag: MPP_SOURCE_TAG,
  }
  if (flags !== 0) tx.Flags = flags
  if (options.assetScale !== undefined) tx.AssetScale = options.assetScale
  if (options.maximumAmount !== undefined) tx.MaximumAmount = options.maximumAmount
  if (transferFee !== undefined && transferFee !== 0) tx.TransferFee = transferFee
  if (options.metadata !== undefined) tx.MPTokenMetadata = encodeMetadata(options.metadata)

  const result = await client.submitAndWait(tx, { wallet: issuer })
  const meta: any = result.result.meta
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `[SUBMISSION_FAILED] MPTokenIssuanceCreate failed: ${meta?.TransactionResult ?? 'unknown'}`,
    )
  }
  const hash = result.result.hash

  const mptIssuanceId =
    typeof meta?.mpt_issuance_id === 'string'
      ? meta.mpt_issuance_id
      : await findLatestIssuanceId(client, issuer.classicAddress)
  if (!mptIssuanceId) {
    throw new Error(
      '[SUBMISSION_FAILED] MPTokenIssuanceCreate succeeded but the resulting ' +
        'mpt_issuance_id could not be located in transaction metadata.',
    )
  }

  return { mpt: { mpt_issuance_id: mptIssuanceId }, hash }
}

/** List every MPT issuance this account has created (issuer side). */
export async function listMPTIssuances(client: Client, issuer: string): Promise<MPTIssuanceInfo[]> {
  const objects = await accountObjects(client, issuer, 'mpt_issuance')
  return objects.map((o) => toIssuanceInfo(o)).filter((i): i is MPTIssuanceInfo => i !== null)
}

/** Issuer-side authorisation of a holder when the issuance has `requireAuthorization`. */
export async function authorizeMPTHolder(
  client: Client,
  issuer: XrplWallet,
  holder: string,
  mpt: MPToken,
): Promise<{ hash: string }> {
  const issuance = await readIssuance(client, mpt.mpt_issuance_id)
  if (!issuance) {
    throw new Error(
      `[MPT_ISSUANCE_NOT_FOUND] MPTokenIssuance ${mpt.mpt_issuance_id} does not exist.`,
    )
  }
  assertIsIssuer(issuer, issuance.Issuer, 'authorize')

  const tx: any = {
    TransactionType: 'MPTokenAuthorize',
    Account: issuer.classicAddress,
    MPTokenIssuanceID: mpt.mpt_issuance_id,
    Holder: holder,
  }
  return { hash: await submitOrThrow(client, issuer, tx, 'MPT_AUTHORIZE_FAILED') }
}

/** Issuer Payment crediting `to` with `amount` MPT units. */
export async function issueMPTPayment(
  client: Client,
  issuer: XrplWallet,
  to: string,
  amount: string,
  mpt: MPToken,
): Promise<{ hash: string }> {
  const issuance = await readIssuance(client, mpt.mpt_issuance_id)
  if (!issuance) {
    throw new Error(
      `[MPT_ISSUANCE_NOT_FOUND] MPTokenIssuance ${mpt.mpt_issuance_id} does not exist.`,
    )
  }
  assertIsIssuer(issuer, issuance.Issuer, 'issue')

  const tx: any = {
    TransactionType: 'Payment',
    Account: issuer.classicAddress,
    Destination: to,
    Amount: { mpt_issuance_id: mpt.mpt_issuance_id, value: amount },
  }
  return { hash: await submitOrThrow(client, issuer, tx, 'SUBMISSION_FAILED') }
}

// ---------------------------------------------------------------------------
// Backward compat for serverCharge auto-MPT-authorize
// ---------------------------------------------------------------------------

/**
 * Legacy helper kept for `serverCharge` autoMPTAuthorize. Delegates to
 * {@link setMPTHolding} but throws the dedicated `MPT_NOT_AUTHORIZED` error
 * when the issuer side is still missing -- the recipient cannot receive the
 * payment in that state.
 */
export async function ensureMPTHolding(params: {
  client: Client
  wallet: XrplWallet
  mpt: MPToken
  autoMPTAuthorize: boolean
}): Promise<void> {
  const { client, wallet, mpt, autoMPTAuthorize } = params

  const issuance = await readIssuance(client, mpt.mpt_issuance_id)
  if (!issuance) {
    throw new Error(
      `[MPT_NOT_AUTHORIZED] MPTokenIssuance ${mpt.mpt_issuance_id} does not exist on the ledger.`,
    )
  }
  const requiresAuth = (issuance.Flags & LSF_ISSUANCE_REQUIRE_AUTH) !== 0

  const existing = await readHoldingRaw(client, wallet.classicAddress, mpt.mpt_issuance_id)
  const issuerOk = !requiresAuth || (!!existing && (existing.flags & LSF_HOLDING_AUTHORIZED) !== 0)
  if (existing && issuerOk) return

  if (!autoMPTAuthorize) {
    throw new Error(
      `[MPT_NOT_AUTHORIZED] Account ${wallet.classicAddress} does not hold MPT ${mpt.mpt_issuance_id}. ` +
        'Set autoMPTAuthorize: true to auto-authorize, or submit MPTokenAuthorize manually.',
    )
  }

  if (!existing) {
    const result = await setMPTHolding(client, wallet, mpt)
    if (result.status === 'pending_authorization') {
      throw new Error(
        `[MPT_NOT_AUTHORIZED] MPTokenIssuance ${mpt.mpt_issuance_id} has lsfMPTRequireAuth set. ` +
          'The holder side of authorization completed, but the issuer must also submit ' +
          'MPTokenAuthorize against this account before payments can succeed.',
      )
    }
    return
  }

  // Holder side already exists but issuer-side allowlist still missing.
  throw new Error(
    `[MPT_NOT_AUTHORIZED] MPTokenIssuance ${mpt.mpt_issuance_id} has lsfMPTRequireAuth set ` +
      `and the issuer has not yet authorised ${wallet.classicAddress}.`,
  )
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type IssuanceLedgerObject = {
  Issuer: string
  Flags: number
  AssetScale?: number
  MaximumAmount?: string
  OutstandingAmount?: string
  TransferFee?: number
  MPTokenMetadata?: string
  /** Some rippled responses include the id directly on the entry; others don't. */
  mpt_issuance_id?: string
}

async function readIssuance(
  client: Client,
  issuanceId: string,
): Promise<IssuanceLedgerObject | null> {
  try {
    const r = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
    } as any)
    const node = (r.result as any).node
    if (!node) return null
    return node as IssuanceLedgerObject
  } catch (err: any) {
    const code = err?.data?.error
    if (code === 'entryNotFound') return null
    // Some servers don't yet support mpt_issuance lookup. Fall back to null
    // so the next submit surfaces a clear error rather than masking it here.
    if (code === 'unknownOption' || code === 'invalidParams') return null
    throw err
  }
}

type RawHolding = {
  mpt_issuance_id: string
  balance: string
  flags: number
}

async function readHoldingRaw(
  client: Client,
  account: string,
  issuanceId: string,
): Promise<RawHolding | null> {
  const objects = await accountObjects(client, account, 'mptoken')
  const found = objects.find((o: any) => o.MPTokenIssuanceID === issuanceId)
  if (!found) return null
  return toRawHolding(found)
}

async function accountObjects(client: Client, account: string, type: string): Promise<any[]> {
  try {
    const response = await client.request({
      command: 'account_objects',
      account,
      type,
    } as any)
    return (response.result as any).account_objects ?? []
  } catch (err: any) {
    const code = err?.data?.error
    if (code === 'actNotFound') return []
    // Older rippled rejects the type filter -- retry without and post-filter.
    if (code === 'invalidParams' || code === 'unknownOption') {
      const response = await client.request({ command: 'account_objects', account } as any)
      const all = (response.result as any).account_objects ?? []
      return all.filter((o: any) => matchesType(o.LedgerEntryType, type))
    }
    throw err
  }
}

function matchesType(ledgerEntryType: unknown, type: string): boolean {
  if (typeof ledgerEntryType !== 'string') return false
  if (type === 'mptoken') return ledgerEntryType === 'MPToken'
  if (type === 'mpt_issuance') return ledgerEntryType === 'MPTokenIssuance'
  return false
}

function toRawHolding(o: any): RawHolding | null {
  if (typeof o?.MPTokenIssuanceID !== 'string') return null
  return {
    mpt_issuance_id: o.MPTokenIssuanceID,
    balance: readAmountString(o.MPTAmount),
    flags: (o.Flags as number) ?? 0,
  }
}

function resolveHolding(raw: RawHolding, issuance: IssuanceLedgerObject | null): MPTHoldingInfo {
  // When the issuance is missing (older rippled, or just-deleted issuance)
  // we fall back to "authorized = true" if the holder's flag is set,
  // otherwise we report not-authorized -- the caller can still see the
  // mismatch via the issuance lookup elsewhere.
  const requiresAuth = issuance !== null && (issuance.Flags & LSF_ISSUANCE_REQUIRE_AUTH) !== 0
  const issuerAuthFlag = (raw.flags & LSF_HOLDING_AUTHORIZED) !== 0
  const issuanceLocked = issuance !== null && (issuance.Flags & LSF_ISSUANCE_LOCKED) !== 0
  return {
    mpt_issuance_id: raw.mpt_issuance_id,
    balance: raw.balance,
    authorized: !requiresAuth || issuerAuthFlag,
    locked: (raw.flags & LSF_HOLDING_LOCKED) !== 0 || issuanceLocked,
  }
}

function toIssuanceInfo(o: any): MPTIssuanceInfo | null {
  if (o?.LedgerEntryType !== 'MPTokenIssuance') return null
  const flags = (o.Flags as number) ?? 0
  const issuanceId: string | undefined = o.mpt_issuance_id ?? o.index
  if (!issuanceId) return null
  return {
    mpt_issuance_id: issuanceId,
    issuer: o.Issuer,
    assetScale: (o.AssetScale as number) ?? 0,
    outstandingAmount: o.OutstandingAmount ?? '0',
    maximumAmount: o.MaximumAmount ?? PROTOCOL_MAX_AMOUNT,
    transferFee: (o.TransferFee as number) ?? 0,
    locked: (flags & LSF_ISSUANCE_LOCKED) !== 0,
    flags: {
      canLock: (flags & LSF_ISSUANCE_CAN_LOCK) !== 0,
      requireAuthorization: (flags & LSF_ISSUANCE_REQUIRE_AUTH) !== 0,
      canEscrow: (flags & LSF_ISSUANCE_CAN_ESCROW) !== 0,
      canTrade: (flags & LSF_ISSUANCE_CAN_TRADE) !== 0,
      canTransfer: (flags & LSF_ISSUANCE_CAN_TRANSFER) !== 0,
      canClawback: (flags & LSF_ISSUANCE_CAN_CLAWBACK) !== 0,
    },
    ...(typeof o.MPTokenMetadata === 'string' ? { metadata: o.MPTokenMetadata } : {}),
  }
}

/**
 * Shape of `MPTAmount` shifted between protocol versions: sometimes a bare
 * string of the integer balance, sometimes wrapped in `{ value }`. Normalise
 * to a string here.
 */
function readAmountString(amount: unknown): string {
  if (amount === undefined || amount === null) return '0'
  if (typeof amount === 'string') return amount
  if (typeof amount === 'object' && 'value' in (amount as any)) {
    return String((amount as any).value)
  }
  return '0'
}

async function findLatestIssuanceId(client: Client, issuer: string): Promise<string | null> {
  const list = await listMPTIssuances(client, issuer)
  // account_objects returns oldest-first; the freshly created issuance is
  // at the end.
  return list.length > 0 ? (list[list.length - 1]?.mpt_issuance_id ?? null) : null
}

function buildCreateFlags(options: CreateTokenOptions): number {
  let flags = 0
  if (options.allowLock) flags |= TF_MPT_CAN_LOCK
  if (options.requireAuthorization) flags |= TF_MPT_REQUIRE_AUTH
  if (options.allowEscrow) flags |= TF_MPT_CAN_ESCROW
  if (options.allowTrade) flags |= TF_MPT_CAN_TRADE
  // allowTransfer defaults to true unless explicitly disabled.
  if (options.allowTransfer !== false) flags |= TF_MPT_CAN_TRANSFER
  if (options.allowClawback) flags |= TF_MPT_CAN_CLAWBACK
  return flags
}

function encodeMetadata(metadata: string | Record<string, unknown>): string {
  let raw: string
  if (typeof metadata === 'string') {
    if (/^[0-9A-Fa-f]+$/.test(metadata) && metadata.length % 2 === 0) {
      // Looks like already-encoded hex -- pass through after size check.
      if (metadata.length / 2 > MAX_MPT_METADATA_BYTES) {
        throw new Error(`[MPT_INVALID_METADATA] Metadata exceeds ${MAX_MPT_METADATA_BYTES} bytes.`)
      }
      return metadata.toUpperCase()
    }
    raw = metadata
  } else {
    raw = JSON.stringify(metadata)
  }
  const bytes = new TextEncoder().encode(raw)
  if (bytes.length > MAX_MPT_METADATA_BYTES) {
    throw new Error(
      `[MPT_INVALID_METADATA] Metadata exceeds ${MAX_MPT_METADATA_BYTES} bytes ` +
        `(got ${bytes.length}).`,
    )
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function assertIsIssuer(wallet: XrplWallet, issuer: string, op: string): void {
  if (wallet.classicAddress !== issuer) {
    throw new Error(
      `[MPT_NOT_ISSUER] ${op}: wallet ${wallet.classicAddress} is not the issuer ` +
        `of this MPT (issuer is ${issuer}).`,
    )
  }
}

async function submitOrThrow(
  client: Client,
  wallet: XrplWallet,
  tx: any,
  errorCode: string,
): Promise<string> {
  // Default the on-chain attribution SourceTag on every MPT tx submitted here.
  if (tx.SourceTag === undefined) tx.SourceTag = MPP_SOURCE_TAG
  const result = await client.submitAndWait(tx, { wallet })
  const meta: any = result.result.meta
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `[${errorCode}] ${tx.TransactionType} failed: ${meta?.TransactionResult ?? 'unknown'}`,
    )
  }
  return result.result.hash
}
