import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, hashes } from 'xrpl'
import { XRPL_RPC_URLS } from '../constants.js'
import { fromTecResult, replayDetected, verificationFailed } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeServerConfig, XrplCurrency } from '../types.js'
import { sameAmount } from '../utils/amount.js'
import { challengeInvoiceId } from '../utils/binding.js'
import { isIOU, isMPT, parseCurrency, serializeCurrency } from '../utils/currency.js'
import { classicAddressFromDID } from '../utils/did.js'
import { canonicalHex, type StoreKeys, storeKeys } from '../utils/keys.js'
import {
  assertLedgerFinality,
  assertTxExpiresWithinChallenge,
  assertTxNotOlderThanChallenge,
  readCurrentLedgerIndex,
  readValidatedLedgerIndex,
} from '../utils/ledger-time.js'
import { ensureMPTHolding } from '../utils/mpt.js'
import { assertRouteTermsMatch } from '../utils/route.js'
import {
  PaymentTransaction,
  paymentMovedMpt,
  TxResponse,
  type TxResponseShape,
} from '../utils/schemas.js'
import {
  assertAtomicStore,
  assertStoreDurability,
  claimKey,
  type ReplayStore,
  replayRetentionFor,
  type StoreDurability,
} from '../utils/store.js'
import { assertSecureRpcUrl } from '../utils/transport.js'
import { ensureTrustline } from '../utils/trustline.js'
import { Wallet } from '../utils/wallet.js'

/**
 * Assumed maximum lifetime of a challenge, matching mppx's own `expires`
 * default of 5 minutes.
 *
 * Not a freshness check: freshness comes from the challenge's `expires`, which
 * is HMAC-covered and which mppx enforces fail-closed before this SDK sees the
 * credential. This value only anchors the *lower* bound on transaction age --
 * the earliest ledger a payment for this challenge could plausibly have settled
 * in is `expires - maxChallengeLifetime`.
 */
const DEFAULT_MAX_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000

/** Default max credential size: 64KB. */
const DEFAULT_MAX_CREDENTIAL_SIZE = 64 * 1024

/**
 * Default validated-ledger confirmations required before a payment is honoured.
 *
 * One means the transaction's own ledger must be validated. Higher values buy
 * protection against a single node reporting a validation its peers have not
 * seen, at roughly 4 seconds of added latency per confirmation.
 */
const DEFAULT_MIN_LEDGER_CONFIRMATIONS = 1

/**
 * How many consecutive `txnNotFound` answers to tolerate before abandoning a
 * hash. Covers propagation lag on a freshly submitted transaction without
 * letting a fabricated hash hold a connection for the whole poll budget.
 */
const NOT_FOUND_ATTEMPTS = 2

/** tfPartialPayment flag -- partial payments can deliver less than Amount. */
const TF_PARTIAL_PAYMENT = 0x00020000

/**
 * Creates an XRPL charge method for use on the **server**.
 *
 * Verifies Payment transactions -- either by:
 * - **pull**: deserializing a signed blob, validating it, then submitting
 * - **push**: looking up a tx hash on-chain and verifying
 *
 * @example
 * ```ts
 * import { Mppx, Store } from 'mppx/server'
 * import { xrpl } from 'xrpl-mpp-sdk/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.charge({
 *       recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
 *       network: 'testnet',
 *     }),
 *   ],
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    recipient,
    currency,
    autoTrustline = false,
    autoTrustlineLimit,
    autoMPTAuthorize = false,
    wallet: walletInput,
    seed,
    network = 'testnet',
    rpcUrl: customRpcUrl,
    store,
    requireStore = true,
    storeDurability,
    allowUnboundPushMode = false,
    allowInsecureTransport = false,
    minLedgerConfirmations = DEFAULT_MIN_LEDGER_CONFIRMATIONS,
    maxChallengeLifetime = DEFAULT_MAX_CHALLENGE_LIFETIME_MS,
    maxCredentialSize = DEFAULT_MAX_CREDENTIAL_SIZE,
    pollTimeout = 60_000,
    pollInterval = 1_000,
  } = parameters

  const recipientWallet: Wallet | undefined =
    walletInput ?? (seed ? Wallet.fromSeed(seed) : undefined)

  if ((autoTrustline || autoMPTAuthorize) && !recipientWallet) {
    throw new Error(
      '[xrpl-mpp-sdk] wallet (or seed) is required when autoTrustline or autoMPTAuthorize is enabled. ' +
        'The server needs to sign TrustSet/MPTokenAuthorize transactions for the recipient account.',
    )
  }

  if (recipientWallet && recipientWallet.address !== recipient) {
    throw new Error(
      `[xrpl-mpp-sdk] recipient wallet does not match recipient address. ` +
        `Wallet derives ${recipientWallet.address}, but recipient is ${recipient}.`,
    )
  }

  if (!store && requireStore) {
    throw new Error(
      '[xrpl-mpp-sdk] store is required for replay protection. ' +
        'Pass requireStore: false to explicitly disable replay protection.',
    )
  }

  // Replay protection is only sound if the store can compare-and-set and is
  // visible to every process serving this recipient. Both are checked at
  // construction so a misconfigured deployment fails at boot, not on the first
  // duplicate credential.
  let replayStore: ReplayStore | undefined
  if (store) {
    assertAtomicStore(store, 'charge replay protection')
    assertStoreDurability({ durability: storeDurability, network, context: 'charge' })
    replayStore = store
  }

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  assertSecureRpcUrl({ rpcUrl, allowInsecureTransport, context: 'charge' })
  // Namespaced by network: channel IDs and transaction hashes are identical
  // across networks for a seed-identical wallet, so an un-namespaced store
  // shared between them confuses their replay state.
  const keys = storeKeys(network)
  const currencyStr = currency ? serializeCurrency(currency) : 'XRP'

  // Auto-setup runs at most once per process: trustline / MPT auth on the
  // recipient is created lazily on first verify rather than at boot, so a
  // restart with no traffic doesn't burn a TrustSet fee. For end-to-end
  // IOU charge against a fresh recipient, the path resolver on the client
  // requires the trustline to exist before signing -- in that case the
  // server should call {@link prepareRecipient} eagerly at boot instead
  // of relying on this lazy setup. Memoised as a promise rather than a boolean
  // so concurrent verifies await the same setup instead of each submitting its
  // own TrustSet.
  let recipientSetup: Promise<void> | undefined
  function ensureRecipientSetup(client: Client): Promise<void> {
    recipientSetup ??= runRecipientSetup(client, {
      currency,
      recipientWallet,
      autoTrustline,
      autoTrustlineLimit,
      autoMPTAuthorize,
    }).catch((error: unknown) => {
      // Do not cache a failure: a transient RPC error should not permanently
      // disable auto-setup for the lifetime of the process.
      recipientSetup = undefined
      throw error
    })
    return recipientSetup
  }

  return Method.toServer(Methods.charge, {
    defaults: {
      currency: currencyStr,
      recipient,
    },
    request({ request }) {
      return {
        ...request,
        methodDetails: {
          ...request.methodDetails,
          reference: crypto.randomUUID(),
          network,
        },
      }
    },
    async verify({ credential, request }) {
      // No cross-request lock: single-use is enforced by atomic compare-and-set
      // on the challenge id and the transaction hash, which holds across
      // processes. A lock here would only serialise unrelated verifies, each of
      // which can hold a submit-and-poll open for up to `pollTimeout`.
      return await doVerify(credential, request)
    },
  })

  async function doVerify(credential: any, routeRequest?: any): Promise<Receipt.Receipt> {
    if (maxCredentialSize > 0) {
      const size = JSON.stringify(credential).length
      if (size > maxCredentialSize) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Credential too large (${size} bytes, max ${maxCredentialSize})`,
        )
      }
    }

    const { challenge } = credential
    const { request: challengeRequest } = challenge
    const challengeExpires = (challenge as { expires?: string }).expires

    // Before anything is derived from the challenge, confirm it asks for what
    // this route charges.
    assertRouteTermsMatch(challengeRequest, routeRequest)

    // Freshness comes from `expires`, not from a locally computed age. mppx
    // covers `expires` with the challenge HMAC and rejects a credential past it
    // fail-closed before this method is reached, so re-deriving it here would be
    // both redundant and weaker. This is a defence-in-depth repeat for callers
    // that invoke `verify` directly rather than through the HTTP middleware.
    assertChallengeFresh(challengeExpires, challenge.id)

    // Retention is per-credential: long enough to outlast the remaining
    // `expires` window plus the time verification may take. Absent `expires`
    // means no authenticated bound on the presentable window, so claims are
    // retained forever rather than guessing a finite value.
    const retentionMs = replayRetentionFor({ expiresIso: challengeExpires, pollTimeout })

    const challengeId = challenge.id as string | undefined
    const expectedAmount = challengeRequest.amount
    const expectedRecipient = challengeRequest.recipient
    const expectedCurrency = parseCurrency(challengeRequest.currency)
    // Bind the payment to this challenge via InvoiceID. An operator-supplied
    // invoiceId takes precedence; otherwise the expected value is derived from
    // the challenge id, which is itself an HMAC over the whole challenge. A
    // payment carrying the wrong binding cannot satisfy this challenge, and a
    // payment made for some other purpose cannot satisfy any challenge.
    const explicitInvoiceId = challengeRequest.methodDetails?.invoiceId as string | undefined
    const boundInvoiceId = challengeId ? challengeInvoiceId(challengeId) : undefined
    const expectedInvoiceId = explicitInvoiceId ?? boundInvoiceId
    const expectedDestinationTag = challengeRequest.methodDetails?.destinationTag as
      | number
      | undefined
    const expectedSourceTag = challengeRequest.methodDetails?.sourceTag as number | undefined
    // Bind the credential to its DID-encoded sender. Without this, an attacker can
    // submit a third party's hash (push) or third party's signed blob (pull) as
    // their own credential.
    const expectedSender = classicAddressFromDID(credential.source)
    const payload = credential.payload

    // Push mode presents an already-validated transaction, so the binding is
    // the only thing tying it to this challenge and is mandatory. Pull mode is
    // additionally protected by account-sequence consumption -- an already
    // settled blob fails tefPAST_SEQ on submit -- so a binding is validated
    // when present but not demanded, which keeps third-party mppx clients
    // that predate this field working.
    const expectations: PaymentExpectations = {
      amount: expectedAmount,
      recipient: expectedRecipient,
      currency: expectedCurrency,
      sender: expectedSender,
      invoiceId: expectedInvoiceId,
      // Required in push mode, where the binding is the only tie to this
      // challenge, and whenever the operator supplied an explicit invoiceId,
      // which is a demand rather than a default.
      invoiceIdRequired:
        (payload.type === 'hash' && !allowUnboundPushMode) || explicitInvoiceId !== undefined,
      destinationTag: expectedDestinationTag,
      sourceTag: expectedSourceTag,
    }

    // Pull mode: decode and validate the blob *before* connecting to the
    // network so a tampered or third-party-signed credential is rejected
    // without holding an open WebSocket.
    let preDecodedTx: any | undefined
    let preDerivedTxHash: string | undefined
    if (payload.type === 'transaction') {
      // Parse the decoded blob rather than casting it: every field below feeds
      // a security comparison, and the blob is entirely client-supplied.
      const decodeResult = PaymentTransaction.safeParse(decode(payload.blob))
      if (!decodeResult.success) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          'Decoded transaction does not match the expected Payment shape',
        )
      }
      preDecodedTx = decodeResult.data
      if (preDecodedTx.TransactionType !== 'Payment') {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Expected Payment transaction, got ${preDecodedTx.TransactionType}`,
        )
      }
      validatePaymentFields(preDecodedTx, expectations)
      preDerivedTxHash = hashes.hashSignedTx(payload.blob)
    }

    // Claim the challenge only once the credential has survived structural
    // validation. Claiming earlier let any malformed or unpaid credential
    // consume a store entry, which is unauthenticated growth, and burned the
    // challenge for a client whose credential was simply malformed.
    if (replayStore) {
      const claimed = await claimKey(
        replayStore,
        keys.challenge(challenge.id),
        { usedAt: new Date().toISOString() },
        retentionMs,
      )
      if (!claimed) throw replayDetected(challenge.id)
    }

    if (replayStore && preDerivedTxHash) {
      const claimed = await claimKey(
        replayStore,
        keys.tx(preDerivedTxHash),
        { status: 'pending', startedAt: Date.now() },
        retentionMs,
      )
      if (!claimed) throw replayDetected(preDerivedTxHash)
    }

    const client = new Client(rpcUrl)
    await client.connect()

    try {
      await ensureRecipientSetup(client)

      // Pull mode: reject blobs whose LastLedgerSequence would let them
      // land past challenge.expires *before* spending a submit. Push mode
      // does the same check after fetching the validated tx in verifyPush.
      if (preDecodedTx && challengeExpires) {
        await assertChallengeExpiryRespected(client, preDecodedTx, challengeExpires)
      }

      switch (payload.type) {
        case 'hash': {
          return await verifyPush(
            client,
            payload.hash,
            expectations,
            replayStore,
            {
              ...(challengeId ? { challengeId } : {}),
              ...(challengeExpires ? { expiresIso: challengeExpires } : {}),
            },
            minLedgerConfirmations,
            maxChallengeLifetime,
            keys,
            retentionMs,
            pollTimeout,
            pollInterval,
          )
        }
        case 'transaction': {
          return await verifyPull(
            client,
            payload.blob,
            preDerivedTxHash,
            replayStore,
            pollTimeout,
            pollInterval,
            minLedgerConfirmations,
            keys,
            retentionMs,
            challengeId,
          )
        }
        default:
          throw verificationFailed(
            'SUBMISSION_FAILED',
            `Unsupported credential type: ${(payload as { type: string }).type}`,
          )
      }
    } finally {
      await client.disconnect()
    }
  }
}

/**
 * Run the LastLedgerSequence vs `challenge.expires` check, wrapping any
 * failure into a typed `VerificationFailedError` (`SUBMISSION_FAILED`).
 *
 * No-op when `tx.LastLedgerSequence` is missing -- the field is
 * technically optional; xrpl.js's autofill always sets it but a
 * hand-crafted tx might not.
 */
async function assertChallengeExpiryRespected(
  client: Client,
  tx: { LastLedgerSequence?: number },
  expiresIso: string,
): Promise<void> {
  const txLLS = tx.LastLedgerSequence
  if (typeof txLLS !== 'number') return
  const currentLedgerIndex = await readCurrentLedgerIndex(client)
  try {
    assertTxExpiresWithinChallenge({
      txLastLedgerSequence: txLLS,
      currentLedgerIndex,
      expiresIso,
    })
  } catch (err: any) {
    const reason =
      typeof err?.message === 'string'
        ? err.message
        : 'LastLedgerSequence vs challenge expiry check failed'
    // Strip the `[CODE] ` prefix the helper adds so verificationFailed's
    // own prefix is not duplicated.
    const detail = reason.replace(/^\[[^\]]+\]\s*/, '')
    throw verificationFailed('SUBMISSION_FAILED', detail)
  }
}

/**
 * Reject a challenge with no usable `expires`, or one already past it.
 *
 * mppx enforces this before `verify` is called in the HTTP flow, so in practice
 * this only fires for a direct `verify` call. It exists because every bound this
 * SDK derives -- replay retention and the transaction-age floor -- is anchored on
 * `expires`, and silently accepting a credential without it would leave those
 * bounds undefined rather than merely loose.
 */
function assertChallengeFresh(expiresIso: string | undefined, challengeId?: string): void {
  if (!expiresIso) {
    // Fail closed. `expires` is the only authenticated statement about how long
    // this credential stays presentable, and every temporal bound the SDK
    // applies is derived from it: without it the freshness check, the
    // LastLedgerSequence cap and the transaction-age floor all no-op at once,
    // which with allowUnboundPushMode leaves no temporal binding whatsoever.
    // Warning and continuing traded a hard bound for a log line.
    //
    // mppx's HTTP middleware always sets `expires`, so this only fires for a
    // caller driving verify() directly with a hand-built challenge.
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `Challenge ${challengeId ?? ''} carries no expires. Issue challenges with an expiry ` +
        '(mppx sets one by default, or use the Expires helpers): every temporal bound on the ' +
        'payment is derived from it.',
    )
  }
  const expiresMs = Date.parse(expiresIso)
  if (Number.isNaN(expiresMs)) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `Challenge ${challengeId ?? ''} carries a malformed expires timestamp: ${expiresIso}`,
    )
  }
  if (expiresMs < Date.now()) {
    throw verificationFailed('SUBMISSION_FAILED', `Challenge expired at ${expiresIso}`)
  }
}

/**
 * Wait until a transaction is final: validated, carrying a ledger index, and
 * buried under `minConfirmations` closed ledgers.
 *
 * Shared by both credential modes so they cannot drift. Returns the raw node
 * response alongside the parsed envelope: the caller still needs the raw shape,
 * because rippled emits Payment fields either nested under `tx_json` or
 * flattened onto the result root, and the envelope schema strips whichever it
 * does not declare.
 *
 * Waiting rules, each chosen so a transient state does not become a permanent
 * rejection of a payment the client has already made:
 *
 * - a definite on-chain failure throws at once
 * - insufficient depth keeps waiting, since that is only a matter of time
 * - a hash the node has never seen is retried a couple of times for propagation
 *   and then abandoned, rather than held for the whole budget: an unauthenticated
 *   caller can mint bogus hashes freely, and each one otherwise pinned a socket
 * - a missing `ledger_index` is refused, because the transaction-age floor is
 *   computed from it and would silently no-op without it
 */
async function awaitFinality(
  client: Client,
  txHash: string,
  options: { minConfirmations: number; pollTimeout: number; pollInterval: number },
): Promise<{ raw: unknown; result: TxResponseShape; txLedgerIndex: number }> {
  const { minConfirmations, pollTimeout, pollInterval } = options
  const deadline = Date.now() + pollTimeout
  let lastSeen: { validated: unknown; txLedgerIndex: number | undefined } | undefined
  let notFoundAttempts = 0

  for (;;) {
    try {
      const response = await client.request({ command: 'tx', transaction: txHash })
      const parsed = TxResponse.safeParse(response.result)
      if (!parsed.success) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Malformed tx response for ${txHash} -- the node returned an unexpected shape`,
        )
      }
      const result = parsed.data
      const meta = result.meta ?? result.metaData

      if (meta?.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') {
        throw fromTecResult(meta.TransactionResult, `Transaction ${txHash} did not succeed`, {
          mpt: paymentMovedMpt(response.result),
        })
      }

      const txLedgerIndex = result.ledger_index
      lastSeen = { validated: result.validated, txLedgerIndex }

      if (meta?.TransactionResult === 'tesSUCCESS' && result.validated === true) {
        if (typeof txLedgerIndex !== 'number') {
          throw verificationFailed(
            'SUBMISSION_FAILED',
            `Transaction ${txHash} was reported validated without a ledger_index, so neither ` +
              'its confirmation depth nor its age can be established.',
          )
        }
        if (await hasEnoughConfirmations(client, txLedgerIndex, minConfirmations)) {
          return { raw: response.result, result, txLedgerIndex }
        }
      }
    } catch (err: any) {
      if (err?.data?.error !== 'txnNotFound') throw err
      notFoundAttempts++
      if (notFoundAttempts > NOT_FOUND_ATTEMPTS) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Transaction ${txHash} is not known to the node. Nothing was submitted under this ` +
            'hash, or it has not propagated.',
        )
      }
    }

    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, pollInterval))
  }

  // Deadline reached without finality. Re-assert against the last observation so
  // the caller learns the specific reason rather than a bare timeout.
  if (lastSeen) {
    try {
      assertLedgerFinality({
        validated: lastSeen.validated,
        txLedgerIndex: lastSeen.txLedgerIndex,
        validatedLedgerIndex: await readValidatedLedgerIndex(client),
        minConfirmations,
        txHash,
      })
    } catch (err: any) {
      const reason = typeof err?.message === 'string' ? err.message : 'Ledger finality check failed'
      throw verificationFailed('SUBMISSION_FAILED', reason.replace(/^\[[^\]]+\]\s*/, ''))
    }
  }

  // Either nothing was ever observed, or finality became satisfied in the gap
  // between the last poll and this check. Both are timeouts from the caller's
  // point of view; never a silent success, and never a silent null.
  throw verificationFailed(
    'SUBMISSION_FAILED',
    `Transaction ${txHash} did not reach ${minConfirmations} validated-ledger ` +
      `confirmation(s) within ${pollTimeout}ms`,
  )
}

/**
 * Verify a push-mode credential (client already submitted, we have the hash).
 */
async function verifyPush(
  client: Client,
  txHash: string,
  expectations: PaymentExpectations,
  store: ReplayStore | undefined,
  challenge: { challengeId?: string; expiresIso?: string },
  minLedgerConfirmations: number,
  maxChallengeLifetime: number,
  keys: StoreKeys,
  retentionMs: number | undefined,
  pollTimeout: number,
  pollInterval: number,
): Promise<Receipt.Receipt> {
  const { challengeId, expiresIso } = challenge
  // Claim the tx hash before verification. The claim is a single atomic
  // put-if-absent, so two replicas presented with the same hash cannot both
  // proceed past this point.
  if (store) {
    const claimed = await claimKey(
      store,
      keys.tx(txHash),
      { status: 'pending', startedAt: Date.now() },
      retentionMs,
    )
    if (!claimed) throw replayDetected(txHash)
  }

  // Wait for finality rather than demanding it on the first look. Depth is a
  // matter of time, and the hash is already claimed above, so failing here
  // would lock the payer out of retrying a payment they have already made.
  const { raw, result, txLedgerIndex } = await awaitFinality(client, txHash, {
    minConfirmations: minLedgerConfirmations,
    pollTimeout,
    pollInterval,
  })

  // Parse the Payment out of the *raw* response, not the envelope: TxResponse is
  // strip mode, so it drops every Payment field, and rippled puts them either
  // under `tx_json` (api_version 2) or on the result root (api_version 1).
  const rawRoot = raw as { tx_json?: unknown }
  const decoded = PaymentTransaction.safeParse(rawRoot.tx_json ?? raw)
  const tx = decoded.success ? decoded.data : undefined
  const meta = result.meta ?? result.metaData

  if (!tx) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `Transaction ${txHash} response carried no Payment fields`,
    )
  }

  if (expiresIso) {
    await assertChallengeExpiryRespected(client, tx, expiresIso)
  }

  // Lower bound on age: a payment that settled before this challenge existed
  // cannot be proof for it. Only reachable in push mode, where the client
  // presents a hash of a transaction the server did not submit.
  if (expiresIso) {
    const currentLedgerIndex = await readCurrentLedgerIndex(client)
    try {
      assertTxNotOlderThanChallenge({
        txLedgerIndex: typeof txLedgerIndex === 'number' ? txLedgerIndex : undefined,
        currentLedgerIndex,
        expiresIso,
        maxChallengeLifetime,
      })
    } catch (err: any) {
      const reason = typeof err?.message === 'string' ? err.message : 'Transaction age check failed'
      throw verificationFailed('SUBMISSION_FAILED', reason.replace(/^\[[^\]]+\]\s*/, ''))
    }
  }

  validatePaymentFields(tx, expectations, meta)

  if (store) {
    await store.put(keys.tx(txHash), {
      status: 'confirmed',
      usedAt: new Date().toISOString(),
      ...(retentionMs !== undefined ? { expiresAt: Date.now() + retentionMs } : {}),
    })
  }

  return Receipt.from({
    method: 'xrpl',
    reference: txHash,
    ...(challengeId ? { externalId: challengeId } : {}),
    status: 'success',
    timestamp: new Date().toISOString(),
  })
}

/**
 * Whether a validated transaction is buried under enough closed ledgers.
 *
 * Non-throwing, because in pull mode the server is waiting for its own
 * submission: insufficient depth means "not yet", not "invalid". Reads the
 * validated ledger index only when a depth beyond the transaction's own ledger
 * is required.
 */
async function hasEnoughConfirmations(
  client: Client,
  txLedgerIndex: unknown,
  minConfirmations: number,
): Promise<boolean> {
  if (minConfirmations <= 1) return true
  if (typeof txLedgerIndex !== 'number') return false
  const validatedLedgerIndex = await readValidatedLedgerIndex(client)
  return validatedLedgerIndex - txLedgerIndex + 1 >= minConfirmations
}

/**
 * Verify a pull-mode credential (we have the signed blob, need to submit).
 */
async function verifyPull(
  client: Client,
  blob: string,
  txHash: string | undefined,
  store: ReplayStore | undefined,
  pollTimeout: number,
  pollInterval: number,
  minLedgerConfirmations: number,
  keys: StoreKeys,
  retentionMs: number | undefined,
  challengeId?: string,
): Promise<Receipt.Receipt> {
  // Field validation, hash derivation, and replay claim already happened in
  // doVerify() before we connected.
  const submitResult = await client.submit(blob)
  const engineResult = submitResult.result.engine_result

  if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
    throw fromTecResult(engineResult, `Transaction submission failed: ${engineResult}`, {
      mpt: paymentMovedMpt(submitResult.result),
    })
  }

  if (txHash) {
    // Same finality wait as push mode: validated, carrying a ledger index, and
    // deep enough. Throws on timeout rather than returning a sentinel.
    await awaitFinality(client, txHash, {
      minConfirmations: minLedgerConfirmations,
      pollTimeout,
      pollInterval,
    })

    if (store) {
      await store.put(keys.tx(txHash), {
        status: 'confirmed',
        usedAt: new Date().toISOString(),
        ...(retentionMs !== undefined ? { expiresAt: Date.now() + retentionMs } : {}),
      })
    }

    return Receipt.from({
      method: 'xrpl',
      reference: txHash,
      ...(challengeId ? { externalId: challengeId } : {}),
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  throw verificationFailed('SUBMISSION_FAILED', 'No transaction hash returned from submit')
}

/**
 * Reject transactions with the tfPartialPayment flag.
 * Partial payments can deliver less than Amount -- an attacker can pay
 * a fraction of the requested amount while passing amount validation.
 */
function rejectPartialPayment(tx: any): void {
  const flags = tx.Flags ?? 0
  if ((flags & TF_PARTIAL_PAYMENT) !== 0) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      'Partial payment flag (tfPartialPayment) is not permitted',
    )
  }
}

/**
 * Everything the challenge says the on-chain Payment must satisfy.
 *
 * Exported from this module for tests only. It is deliberately absent from
 * `xrpl-mpp-sdk/server`, so it is not part of the public API.
 */
export type PaymentExpectations = {
  amount: string
  recipient: string
  currency: XrplCurrency
  /** Classic address decoded from the credential's DID `source`. */
  sender: string
  /** Challenge binding, or an operator-supplied invoiceId when set. */
  invoiceId?: string | undefined
  /**
   * Reject the payment when it carries no `InvoiceID` at all.
   *
   * Set for push mode, where the binding is the only thing tying the payment to
   * this challenge, and whenever the challenge carried an explicit `invoiceId`.
   * Only a derived binding on the pull path is optional.
   */
  invoiceIdRequired: boolean
  destinationTag?: number | undefined
  sourceTag?: number | undefined
}

/**
 * Validate Payment tx fields (Account, Destination, Amount, Currency,
 * InvoiceID, tags) against challenge.
 *
 * Exported from this module for tests only; not re-exported from
 * `xrpl-mpp-sdk/server`.
 */
export function validatePaymentFields(tx: any, expected: PaymentExpectations, meta?: any): void {
  const {
    amount: expectedAmount,
    recipient: expectedRecipient,
    currency: expectedCurrency,
    sender: expectedSender,
    invoiceId: expectedInvoiceId,
    invoiceIdRequired,
    destinationTag: expectedDestinationTag,
    sourceTag: expectedSourceTag,
  } = expected

  // Checked here rather than only on the pull path: push mode presents a hash,
  // so without this an EscrowCreate or PaymentChannelCreate with the right
  // Destination and Amount passed as proof of payment. Neither delivers funds --
  // an escrow can be cancelled back to the sender, a channel deposit reclaimed
  // after SettleDelay.
  if (tx.TransactionType !== 'Payment') {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `Expected a Payment transaction, got ${tx.TransactionType ?? 'none'}`,
    )
  }

  rejectPartialPayment(tx)

  // Bind the on-chain payer to the credential's DID source. This blocks
  // hash-theft (push) and third-party-blob replay (pull).
  if (tx.Account !== expectedSender) {
    throw verificationFailed(
      'SOURCE_MISMATCH',
      `Expected payer ${expectedSender} (from credential source), got ${tx.Account}`,
    )
  }

  // Presence is checked independently of whether an expected value could be
  // derived. Nesting it under `expectedInvoiceId` meant a challenge with no id
  // and no explicit invoiceId skipped the check -- precisely the case where
  // nothing else binds the payment to the challenge either.
  if (invoiceIdRequired && tx.InvoiceID === undefined) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      'Payment carries no InvoiceID, so it is not bound to this challenge. Set InvoiceID to ' +
        'the value the challenge asked for, or sha512half(challenge.id) when the challenge ' +
        'carries no explicit invoiceId. For push mode specifically, ' +
        'allowUnboundPushMode: true accepts unbound payments (not recommended -- any prior ' +
        'payment by the same account with matching terms then satisfies any challenge).',
    )
  }

  // Absent is tolerated in exactly one case, handled above: the expected value
  // is the binding this SDK derives and the mode does not require it, so a
  // third-party mppx client predating the field still works.
  // Compared canonically: the schema accepts a lowercase invoiceId from an
  // operator, while the ledger always reports Hash256 fields uppercase, so a
  // case-sensitive compare refused a payment bound exactly as asked.
  if (
    expectedInvoiceId &&
    tx.InvoiceID !== undefined &&
    canonicalHex(tx.InvoiceID) !== canonicalHex(expectedInvoiceId)
  ) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `InvoiceID mismatch: expected ${expectedInvoiceId}, got ${tx.InvoiceID}`,
    )
  }

  if (expectedDestinationTag !== undefined && tx.DestinationTag !== expectedDestinationTag) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `DestinationTag mismatch: expected ${expectedDestinationTag}, got ${tx.DestinationTag ?? 'none'}`,
    )
  }

  if (expectedSourceTag !== undefined && tx.SourceTag !== expectedSourceTag) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `SourceTag mismatch: expected ${expectedSourceTag}, got ${tx.SourceTag ?? 'none'}`,
    )
  }

  const destination = tx.Destination
  if (destination !== expectedRecipient) {
    throw verificationFailed(
      'RECIPIENT_MISMATCH',
      `Expected recipient ${expectedRecipient}, got ${destination}`,
    )
  }

  // Use delivered_amount from meta when available (push mode / validated tx).
  // delivered_amount reflects the actual amount received; tx.Amount is the maximum.
  const txAmount = meta?.delivered_amount ?? tx.Amount ?? tx.DeliverMax

  if (expectedCurrency === 'XRP') {
    if (typeof txAmount !== 'string') {
      throw verificationFailed('AMOUNT_MISMATCH', 'Expected XRP (drops string), got object')
    }
    if (!sameAmount(txAmount, expectedAmount)) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected ${expectedAmount} drops, got ${txAmount}`,
      )
    }
  } else if ('currency' in expectedCurrency) {
    if (typeof txAmount !== 'object') {
      throw verificationFailed('AMOUNT_MISMATCH', 'Expected IOU amount object, got string')
    }
    if (txAmount.currency !== expectedCurrency.currency) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected currency ${expectedCurrency.currency}, got ${txAmount.currency}`,
      )
    }
    if (txAmount.issuer !== expectedCurrency.issuer) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected issuer ${expectedCurrency.issuer}, got ${txAmount.issuer}`,
      )
    }
    if (!sameAmount(txAmount.value, expectedAmount)) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected amount ${expectedAmount}, got ${txAmount.value}`,
      )
    }
  } else if ('mpt_issuance_id' in expectedCurrency) {
    if (typeof txAmount !== 'object') {
      throw verificationFailed('AMOUNT_MISMATCH', 'Expected MPT amount object, got string')
    }
    if (txAmount.mpt_issuance_id !== expectedCurrency.mpt_issuance_id) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected MPT ${expectedCurrency.mpt_issuance_id}, got ${txAmount.mpt_issuance_id}`,
      )
    }
    if (!sameAmount(txAmount.value, expectedAmount)) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected amount ${expectedAmount}, got ${txAmount.value}`,
      )
    }
  }
}

export declare namespace charge {
  export type Parameters = ChargeServerConfig & {
    /**
     * Store for replay protection. Must support atomic compare-and-set, which
     * `Store.memory()`, `Store.redis()`, `Store.upstash()` and
     * `Store.cloudflare()` all do.
     */
    store?: Store.AtomicStore
    /** Require a store for replay protection. @default true */
    requireStore?: boolean
    /**
     * Attestation of how the store is shared. Required on mainnet and whenever
     * `NODE_ENV=production`, where an undeclared or `process-local` store is
     * refused: replay state that is not shared across replicas lets settled
     * value be redeemed once per process.
     */
    storeDurability?: StoreDurability
    /**
     * Accept push-mode payments that carry no challenge binding.
     *
     * Push mode presents a hash of an already-validated transaction, so the
     * `InvoiceID` binding is the only thing tying it to a specific challenge.
     * Without it, any prior payment by the same account with a matching amount
     * and currency satisfies any future challenge. Enable only for legacy
     * clients that cannot set `InvoiceID`, and treat it as an accepted risk.
     *
     * @default false
     */
    allowUnboundPushMode?: boolean
    /**
     * Permit a non-`wss:` `rpcUrl`.
     *
     * Payment verification depends on this connection, so plaintext lets an
     * on-path attacker rewrite settlement results. Loopback hosts are always
     * allowed without this flag, so it is only needed for a non-local node
     * reached over an unencrypted transport.
     *
     * @default false
     */
    allowInsecureTransport?: boolean
    /**
     * Validated-ledger confirmations required before a payment is honoured.
     *
     * `1` requires the transaction's own ledger to be validated. Higher values
     * additionally wait for that many closed ledgers, which costs roughly 4
     * seconds each but protects against a node reporting a validation its peers
     * have not seen. `0` accepts any validated transaction without a depth
     * check; the `validated` flag itself is always required.
     *
     * @default 1
     */
    minLedgerConfirmations?: number
    /**
     * Assumed maximum lifetime of a challenge, in ms.
     *
     * Not a freshness check. Freshness comes from the challenge's `expires`,
     * which is covered by the challenge HMAC and which mppx rejects fail-closed
     * before this method runs. This value only anchors the lower bound on
     * transaction age: the earliest ledger a payment for this challenge could
     * have settled in is `expires - maxChallengeLifetime`. Set it to match the
     * `expires` window you issue.
     *
     * @default 300000 (5 min, matching mppx's own `expires` default)
     */
    maxChallengeLifetime?: number
    /** Max credential size in bytes. 0 disables. @default 65536 (64KB) */
    maxCredentialSize?: number
    /** Polling timeout for tx validation in milliseconds. @default 60000 */
    pollTimeout?: number
    /** Polling interval for tx validation in milliseconds. @default 1000 */
    pollInterval?: number
  }
}

/**
 * Run the recipient-side trustline / MPT-auth setup once. Shared between
 * the lazy path inside `charge()` and the eager `prepareRecipient()`.
 */
async function runRecipientSetup(
  client: Client,
  config: {
    currency?: XrplCurrency
    recipientWallet?: Wallet
    autoTrustline: boolean
    autoTrustlineLimit?: string
    autoMPTAuthorize: boolean
  },
): Promise<void> {
  const { currency, recipientWallet, autoTrustline, autoTrustlineLimit, autoMPTAuthorize } = config
  if (!currency || !recipientWallet) return
  const xrplWallet = recipientWallet._xrplWallet

  if (isIOU(currency) && autoTrustline) {
    await ensureTrustline({
      client,
      wallet: xrplWallet,
      currency,
      autoTrustline: true,
      trustlineLimit: autoTrustlineLimit,
    })
  }

  if (isMPT(currency) && autoMPTAuthorize) {
    await ensureMPTHolding({
      client,
      wallet: xrplWallet,
      mpt: currency,
      autoMPTAuthorize: true,
    })
  }
}

/**
 * Eagerly run the recipient-side `TrustSet` (when {@link charge.Parameters.autoTrustline}
 * is on and the currency is an IOU) and `MPTokenAuthorize` (when
 * {@link charge.Parameters.autoMPTAuthorize} is on and the currency is
 * an MPT) for the recipient wallet.
 *
 * Why call this instead of relying on lazy setup inside `verify()`?
 *
 * For IOU charges, the client-side path resolver requires the recipient's
 * trustline to *already* exist in order to find a viable
 * `ripple_path_find` alternative or to fall through to the direct-trustline
 * shortcut. If the trustline only appears in `verify()` (after the client
 * has already signed), the client throws `PAYMENT_PATH_FAILED` before the
 * server ever sees the credential. Calling `prepareRecipient()` once at
 * boot (or before issuing the first 402 in this currency) fixes that
 * chicken-and-egg.
 *
 * For MPT charges, lazy setup works end-to-end (MPTs do not go through
 * the path resolver), but eager setup is still useful to fail fast at
 * boot if the wallet cannot cover the owner reserve increment.
 *
 * Idempotent: returns immediately on a second call once the trustline
 * or MPT holding is in place. Opens and closes its own xrpl.Client.
 *
 * Throws when no `wallet` (or `seed`) is configured -- the function needs
 * to sign on behalf of the recipient. Returns silently when the configured
 * `currency` is XRP (nothing to set up) or when both auto-setup flags
 * are off.
 *
 * @example
 * ```ts
 * import { charge, prepareRecipient } from 'xrpl-mpp-sdk/server'
 *
 * const params = {
 *   recipient: recipient.address,
 *   wallet: recipient,
 *   currency: { currency: 'USD', issuer: 'rIssuer...' },
 *   autoTrustline: true,
 *   network: 'testnet',
 *   store: Store.memory(),
 * } satisfies charge.Parameters
 *
 * await prepareRecipient(params)   // creates the trustline once at boot
 * const method = charge(params)    // method is now ready to verify
 * ```
 */
export async function prepareRecipient(parameters: charge.Parameters): Promise<void> {
  const {
    recipient,
    currency,
    autoTrustline = false,
    autoTrustlineLimit,
    autoMPTAuthorize = false,
    wallet: walletInput,
    seed,
    network = 'testnet',
    rpcUrl: customRpcUrl,
  } = parameters

  const recipientWallet: Wallet | undefined =
    walletInput ?? (seed ? Wallet.fromSeed(seed) : undefined)

  if (!recipientWallet) {
    throw new Error(
      '[xrpl-mpp-sdk] wallet (or seed) is required to call prepareRecipient. ' +
        'The function signs TrustSet / MPTokenAuthorize on the recipient account.',
    )
  }

  if (recipientWallet.address !== recipient) {
    throw new Error(
      `[xrpl-mpp-sdk] recipient wallet does not match recipient address. ` +
        `Wallet derives ${recipientWallet.address}, but recipient is ${recipient}.`,
    )
  }

  if (!currency || (!autoTrustline && !autoMPTAuthorize)) return

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(rpcUrl)
  await client.connect()
  try {
    await runRecipientSetup(client, {
      currency,
      recipientWallet,
      autoTrustline,
      autoTrustlineLimit,
      autoMPTAuthorize,
    })
  } finally {
    await client.disconnect()
  }
}
