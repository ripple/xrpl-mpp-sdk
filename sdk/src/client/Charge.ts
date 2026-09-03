import { Credential, Method } from 'mppx'
import type { Payment } from 'xrpl'
import { Client } from 'xrpl'
import { z } from 'zod/mini'
import { MPP_SOURCE_TAG, type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import { challengeRejected, fromTecResult } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeClientConfig, PaymentMode } from '../types.js'
import { challengeInvoiceId } from '../utils/binding.js'
import { buildAmount, isIOU, parseCurrency } from '../utils/currency.js'
import { lastLedgerSequenceFromExpires, readCurrentLedgerIndex } from '../utils/ledger-time.js'
import { resolveIouPaymentExtras, validateSlippageBps } from '../utils/paths.js'
import { runPreflight } from '../utils/validation.js'
import { resolveWallet } from '../utils/wallet.js'

/**
 * XRPL charge method for the client.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { xrpl } from 'xrpl-mpp-sdk/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.charge({ seed: 'sEdV...' }),
 *   ],
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    wallet: walletInput,
    seed,
    mode: defaultMode = 'pull',
    preflight: runPreflightCheck = true,
    slippageBps = 50,
    pathFindRetryDelaysMs,
    network: defaultNetwork = 'testnet',
    rpcUrl: defaultRpcUrl,
    onProgress,
    expectedRecipient,
    maxAmount,
    allowedCurrencies,
  } = parameters

  // Distinguishes "explicitly chose testnet" from "did not say", which the
  // destructured default cannot express. Only an explicit choice pins.
  const pinnedNetwork = parameters.network

  if (!walletInput && !seed) {
    throw new Error('A wallet or seed is required for the client charge method.')
  }

  validateSlippageBps(slippageBps)

  const wallet = resolveWallet({ wallet: walletInput, seed })._xrplWallet

  return Method.toClient(Methods.charge, {
    context: z.object({
      mode: z.optional(z.enum(['push', 'pull'])),
    }),
    async createCredential({ challenge, context }) {
      const { request } = challenge
      const { amount, currency: currencyStr, recipient } = request

      // Client-side authorization guardrails (mpp.dev, Amount verification):
      // fail closed before signing or connecting when the challenge terms fall
      // outside the caller's configured bounds. Runs before parseCurrency so an
      // out-of-allowlist currency is reported as CHALLENGE_REJECTED, not a parse
      // error.
      if (expectedRecipient !== undefined) {
        const allowed = Array.isArray(expectedRecipient) ? expectedRecipient : [expectedRecipient]
        if (!allowed.includes(recipient)) {
          throw challengeRejected(
            `challenge recipient ${recipient} is not in the expected recipient allowlist.`,
          )
        }
      }
      if (maxAmount !== undefined && BigInt(amount) > BigInt(maxAmount)) {
        throw challengeRejected(
          `challenge amount ${amount} exceeds the configured maxAmount ${maxAmount}.`,
        )
      }
      if (allowedCurrencies !== undefined && !allowedCurrencies.includes(currencyStr)) {
        throw challengeRejected(
          `challenge currency ${currencyStr} is not in the allowed currencies list.`,
        )
      }

      // The challenge names the ledger, and this client follows it. That is the
      // right default -- the server knows which ledger it settles on -- but it
      // means an unpinned client signs wherever it is told to.
      //
      // The same seed controls the same address on every XRPL network, so a
      // client whose wallet holds real XRP will sign against that balance if a
      // challenge declares `mainnet`, whatever it was configured for. A caller
      // that passed `network` explicitly is pinning it, and a challenge naming
      // another one is refused rather than followed.
      const challengeNetwork = request.methodDetails?.network as NetworkId | undefined
      if (
        pinnedNetwork !== undefined &&
        challengeNetwork !== undefined &&
        challengeNetwork !== pinnedNetwork
      ) {
        throw challengeRejected(
          `challenge is for the ${challengeNetwork} network but this client is pinned to ` +
            `${pinnedNetwork}. Signing it would settle on a ledger the caller did not choose.`,
        )
      }
      const network = challengeNetwork ?? defaultNetwork
      const rpcUrl = defaultRpcUrl ?? XRPL_RPC_URLS[network]

      const currency = parseCurrency(currencyStr)
      const xrplAmount = buildAmount(amount, currency)

      onProgress?.({ type: 'challenge', recipient, amount, currency: currencyStr })

      // 60s per-request timeout. ripple_path_find for cross-issuer payments
      // can exceed xrpl.js's 20s default while the path indexer warms.
      const client = new Client(rpcUrl, { timeout: 60_000 })
      await client.connect()

      try {
        if (runPreflightCheck) {
          onProgress?.({ type: 'preflight' })
          await runPreflight({
            client,
            wallet,
            currency,
            destination: recipient,
            amount,
          })
        }

        // For IOU payments, resolve Paths + SendMax before signing. Covers
        // cross-issuer payments (path-find + chosen alternative) and direct
        // payments where the issuer charges a TransferRate.
        let pathsField: { Paths?: unknown; SendMax?: unknown } = {}
        if (isIOU(currency) && typeof xrplAmount === 'object' && 'currency' in xrplAmount) {
          onProgress?.({ type: 'pathfinding' })
          const extras = await resolveIouPaymentExtras({
            client,
            sender: wallet.classicAddress,
            recipient,
            destinationAmount: xrplAmount,
            slippageBps,
            ...(pathFindRetryDelaysMs ? { pathFindRetryDelaysMs } : {}),
          })
          pathsField = {
            ...(extras.Paths ? { Paths: extras.Paths } : {}),
            ...(extras.SendMax ? { SendMax: extras.SendMax } : {}),
          }
          onProgress?.({
            type: 'paths_resolved',
            strategy: extras.strategy,
            sourceAmountValue: extras.sourceAmountValue,
            sourceAmountCurrency: extras.sourceAmountCurrency,
          })
        }

        // Bind the payment to this challenge. An operator-supplied invoiceId
        // wins (it may carry merchant reconciliation data), otherwise derive it
        // from the challenge id so the transaction can only ever satisfy the
        // challenge it was signed for.
        const boundInvoiceId =
          request.methodDetails?.invoiceId ??
          (challenge.id ? challengeInvoiceId(challenge.id) : undefined)

        const payment = {
          TransactionType: 'Payment' as const,
          Account: wallet.classicAddress,
          Destination: recipient,
          Amount: xrplAmount,
          ...pathsField,
          ...(boundInvoiceId ? { InvoiceID: boundInvoiceId } : {}),
          ...(request.methodDetails?.destinationTag !== undefined
            ? { DestinationTag: request.methodDetails.destinationTag }
            : {}),
          // Default the on-chain attribution SourceTag; a challenge-provided
          // sourceTag (single 32-bit field) takes precedence.
          SourceTag: request.methodDetails?.sourceTag ?? MPP_SOURCE_TAG,
          ...(request.methodDetails?.memos && request.methodDetails.memos.length > 0
            ? { Memos: encodeMemos(request.methodDetails.memos) }
            : {}),
        }

        const prepared = await client.autofill(payment as Payment)

        // Cap LastLedgerSequence to challenge.expires when set: xrpl.js's
        // autofill default (~current + 4 ledgers, ~16 s) can outlive a
        // tight challenge, leaving a window for an attacker who
        // intercepts the signed blob to re-submit just before the
        // ledger-side deadline. Always tighten, never relax.
        const expiresIso = (challenge as { expires?: string }).expires
        if (expiresIso) {
          const currentLedgerIndex = await readCurrentLedgerIndex(client)
          const cap = lastLedgerSequenceFromExpires({ currentLedgerIndex, expiresIso })
          const autofilled = (prepared as { LastLedgerSequence?: number }).LastLedgerSequence
          if (autofilled === undefined || cap < autofilled) {
            ;(prepared as { LastLedgerSequence?: number }).LastLedgerSequence = cap
          }
        }

        onProgress?.({ type: 'signing' })
        const signed = wallet.sign(prepared)
        const effectiveMode: PaymentMode = context?.mode ?? defaultMode
        onProgress?.({ type: 'signed', mode: effectiveMode })

        if (effectiveMode === 'push') {
          onProgress?.({ type: 'submitting' })
          const result = await client.submitAndWait(signed.tx_blob)
          const meta = result.result.meta as any
          if (meta?.TransactionResult !== 'tesSUCCESS') {
            throw fromTecResult(
              meta?.TransactionResult ?? 'unknown',
              `Transaction failed: ${meta?.TransactionResult ?? 'unknown'}`,
            )
          }

          onProgress?.({ type: 'confirmed', hash: signed.hash })

          return Credential.serialize({
            challenge,
            payload: { type: 'hash' as const, hash: signed.hash },
            source: `did:pkh:xrpl:${network}:${wallet.classicAddress}`,
          })
        }

        return Credential.serialize({
          challenge,
          payload: { type: 'transaction' as const, blob: signed.tx_blob },
          source: `did:pkh:xrpl:${network}:${wallet.classicAddress}`,
        })
      } finally {
        await client.disconnect()
      }
    },
  })
}

export declare namespace charge {
  export type Parameters = ChargeClientConfig
}

type ChallengeMemo = { type?: string; format?: string; data?: string }

/**
 * Encode UTF-8 memo fields as hex per XRPL Memos[].Memo encoding. Each field
 * is optional; absent fields are dropped from the encoded entry.
 */
function encodeMemos(
  memos: ChallengeMemo[],
): Array<{ Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }> {
  return memos.map((m) => {
    const memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } = {}
    if (m.type) memo.MemoType = utf8ToHex(m.type)
    if (m.format) memo.MemoFormat = utf8ToHex(m.format)
    if (m.data) memo.MemoData = utf8ToHex(m.data)
    return { Memo: memo }
  })
}

function utf8ToHex(s: string): string {
  return Buffer.from(s, 'utf8').toString('hex').toUpperCase()
}
