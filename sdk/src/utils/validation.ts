import type { Client, Wallet } from 'xrpl'
import type { IssuedCurrency, XrplCurrency } from '../types.js'
import { isIOU, isXrp } from './currency.js'
import { assertReserveCovers, getReserveState } from './reserves.js'

/** Default fee estimate in drops (12 drops per tx). */
const DEFAULT_FEE_DROPS = 12n

/**
 * Pre-flight validation for the **client** side. Read-only checks, no side effects.
 *
 * 1. Destination account exists on-chain
 * 2. Sufficient XRP balance for reserves, fees, and (if XRP) payment amount
 *    -- and one extra owner reserve when `addedOwnerObjects > 0`
 *    (e.g., when an automatic TrustSet will be issued before the payment).
 * 3. Issuer health for IOU payments: rippling enabled, not globally frozen.
 */
export async function runPreflight(params: {
  client: Client
  wallet: Wallet
  currency: XrplCurrency
  destination: string
  amount?: string
  /**
   * Number of owner objects the operation will add (TrustSet, MPTokenAuthorize,
   * PaymentChannelCreate, etc.). The reserve check then asserts the wallet has
   * enough XRP for the *new* reserve floor.
   */
  addedOwnerObjects?: number
}): Promise<void> {
  const { client, wallet, currency, destination, amount, addedOwnerObjects = 0 } = params

  await verifyDestination(client, destination)
  await checkSufficientBalance({ client, wallet, currency, amount, addedOwnerObjects })

  if (isIOU(currency)) {
    await assertIssuerHealth(client, currency)
  }
}

/**
 * Check that the wallet has enough XRP to cover:
 * - Future reserve: base + (ownerCount + addedOwnerObjects) * inc
 * - Transaction fee
 * - Payment amount (only if paying in XRP)
 *
 * Throws INSUFFICIENT_BALANCE / INSUFFICIENT_RESERVE with an actionable message.
 */
async function checkSufficientBalance(params: {
  client: Client
  wallet: Wallet
  currency: XrplCurrency
  amount?: string
  addedOwnerObjects: number
}): Promise<void> {
  const { client, wallet, currency, amount, addedOwnerObjects } = params

  const state = await getReserveState(client, wallet.classicAddress)
  if (!state) {
    throw new Error(
      `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} does not exist on the ledger. ` +
        'Fund it with at least the base reserve (1 XRP) to activate it.',
    )
  }

  const paymentDrops = isXrp(currency) && amount ? BigInt(amount) : 0n
  assertReserveCovers({
    account: wallet.classicAddress,
    state,
    addedOwnerObjects,
    feeDrops: DEFAULT_FEE_DROPS,
    paymentDrops,
    kind: 'preflight',
  })
}

const LSF_DEFAULT_RIPPLE = 0x00800000
const LSF_GLOBAL_FREEZE = 0x00400000
const LSF_REQUIRE_AUTH = 0x00040000

/** Read issuer flags via account_info; returns 0 if the issuer does not exist. */
async function readIssuerFlags(client: Client, issuer: string): Promise<number> {
  try {
    const r = await client.request({ command: 'account_info', account: issuer })
    return (r.result.account_data.Flags as number) ?? 0
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return 0
    throw err
  }
}

/**
 * Assert the IOU issuer is in a healthy state: rippling enabled, no global
 * freeze, and (if RequireAuth is set) callers should expect a per-trustline
 * authorization step. Surfaces typed errors that map onto the SDK error codes.
 *
 * Exposed so trustline-creation flows can call it without re-running the full
 * preflight.
 */
export async function assertIssuerHealth(
  client: Client,
  currency: IssuedCurrency,
): Promise<{ requiresAuth: boolean }> {
  const flags = await readIssuerFlags(client, currency.issuer)
  if ((flags & LSF_GLOBAL_FREEZE) !== 0) {
    throw new Error(
      `[ISSUER_GLOBAL_FROZEN] Issuer ${currency.issuer} has set lsfGlobalFreeze. All ` +
        `transfers of ${currency.currency} are blocked until the issuer clears the freeze.`,
    )
  }
  if ((flags & LSF_DEFAULT_RIPPLE) === 0) {
    throw new Error(
      `[PAYMENT_PATH_FAILED] Issuer ${currency.issuer} does not have DefaultRipple enabled. ` +
        'IOU payments require rippling on the issuer account (asfDefaultRipple).',
    )
  }
  return { requiresAuth: (flags & LSF_REQUIRE_AUTH) !== 0 }
}

/**
 * Verify that a destination account exists on the ledger.
 * Prevents funds sent to non-existent accounts (tecNO_DST).
 */
async function verifyDestination(client: Client, address: string): Promise<void> {
  try {
    await client.request({ command: 'account_info', account: address })
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') {
      throw new Error(
        `[RECIPIENT_NOT_FOUND] Destination account ${address} does not exist on the ledger.`,
      )
    }
    throw err
  }
}
