import { Credential, Method } from 'mppx'
import { Client, signPaymentChannelClaim, unixTimeToRippleTime } from 'xrpl'
import { z } from 'zod/mini'
import { MPP_SOURCE_TAG, type NetworkId, XRPL_RPC_URLS } from '../../constants.js'
import type { ChannelClientConfig } from '../../types.js'
import { dropsToXrpString } from '../../utils/amount.js'
import { lastLedgerSequenceFromExpires, readCurrentLedgerIndex } from '../../utils/ledger-time.js'
import { assertReserveCovers, getReserveState } from '../../utils/reserves.js'
import { resolveWallet, type Wallet } from '../../utils/wallet.js'
import { channel as ChannelMethod } from '../Methods.js'

/**
 * Creates an XRPL channel method for use on the **client**.
 *
 * Signs cumulative PayChannel claim commitments off-chain using
 * signPaymentChannelClaim from xrpl.js. Supports both ed25519 and
 * secp256k1 wallets transparently.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { xrpl } from 'xrpl-mpp-sdk/channel/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.channel({ seed: 'sEdV...' }),
 *   ],
 * })
 * ```
 */
export function channel(parameters: channel.Parameters) {
  const {
    wallet: walletInput,
    seed,
    network: defaultNetwork = 'testnet',
    rpcUrl: _defaultRpcUrl,
  } = parameters

  if (!walletInput && !seed) {
    throw new Error('A wallet or seed is required for the client channel method.')
  }

  const wallet = resolveWallet({ wallet: walletInput, seed })

  return Method.toClient(ChannelMethod, {
    context: z.object({
      cumulativeAmount: z.optional(z.string()),
      action: z.optional(z.enum(['voucher', 'close', 'open'])),
      /** Signed PaymentChannelCreate tx blob -- required for action: 'open'. */
      openTransaction: z.optional(z.string()),
    }),
    async createCredential({ challenge, context }) {
      const { request } = challenge
      const { amount, channelId } = request
      const network = (request.methodDetails?.network as string) ?? defaultNetwork

      const action = context?.action ?? 'voucher'

      if (action === 'open') {
        if (!context?.openTransaction) {
          throw new Error('openTransaction is required for action: open')
        }
        const initialAmount = amount
        const initialXrp = dropsToXrpString(initialAmount)
        // The real channelId is unknown until the server broadcasts the open
        // tx. Sign over an all-zero placeholder; the server verifies the
        // signature against the real channelId after extracting it from
        // metadata, and rejects the credential if initialAmount > 0 and the
        // signature does not match.
        const signature = signPaymentChannelClaim(
          channelId || '0'.repeat(64),
          initialXrp,
          wallet.privateKey,
        )

        return Credential.serialize({
          challenge,
          payload: {
            action: 'open' as const,
            transaction: context.openTransaction,
            amount: initialAmount,
            signature,
          },
          source: `did:pkh:xrpl:${network}:${wallet.address}`,
        })
      }

      const previousCumulative = BigInt(request.methodDetails?.cumulativeAmount ?? '0')
      const cumulativeAmount =
        context?.cumulativeAmount !== undefined
          ? BigInt(context.cumulativeAmount)
          : previousCumulative + BigInt(amount)

      const cumulativeStr = cumulativeAmount.toString()

      // signPaymentChannelClaim expects XRP, not drops -- it internally calls xrpToDrops.
      const cumulativeXrp = dropsToXrpString(cumulativeStr)
      const signature = signPaymentChannelClaim(channelId, cumulativeXrp, wallet.privateKey)

      return Credential.serialize({
        challenge,
        payload: {
          action,
          channelId,
          amount: cumulativeStr,
          signature,
        },
        source: `did:pkh:xrpl:${network}:${wallet.address}`,
      })
    },
  })
}

export declare namespace channel {
  export type Parameters = ChannelClientConfig
}

/**
 * Open a new PayChannel on-chain.
 *
 * Creates a PaymentChannelCreate transaction and returns the channel ID.
 */
/**
 * Convert a channel deadline to ripple time.
 *
 * `CancelAfter` is ripple time on the wire -- seconds since 2000-01-01 -- and
 * this used to take that value raw. A caller passing a Unix timestamp got a
 * deadline thirty years out, silently, which defeats the one field whose whole
 * purpose is to bound how long a channel can outlive its session.
 *
 * A `number` is therefore Unix milliseconds, matching `expiresAt` in the same
 * options object and `cancelAfter` on the escrow helpers. A past deadline is
 * rejected rather than submitted for the ledger to refuse.
 */
function channelCancelAfterToRippleTime(input: Date | number | string): number {
  const unixMs =
    input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(unixMs)) {
    throw new Error(
      `[INVALID_AMOUNT] PaymentChannelCreate \`cancelAfter\` is not a valid timestamp: ${String(input)}.`,
    )
  }
  if (unixMs <= Date.now()) {
    throw new Error(
      `[INVALID_AMOUNT] PaymentChannelCreate \`cancelAfter\` must be in the future. Got ` +
        `${new Date(unixMs).toISOString()}, now is ${new Date().toISOString()}. Note that a ` +
        'number is Unix milliseconds here, not ripple time.',
    )
  }
  return unixTimeToRippleTime(unixMs)
}

export async function openChannel(params: {
  /** Funder wallet. Preferred over `seed`. */
  wallet?: Wallet
  /** Family seed of the funder. Kept for backward compatibility -- prefer `wallet`. */
  seed?: string
  destination: string
  amount: string
  settleDelay: number
  publicKey?: string
  cancelAfter?: Date | number | string
  network?: NetworkId
  rpcUrl?: string
}): Promise<{ channelId: string; txHash: string }> {
  const {
    wallet: walletInput,
    seed,
    destination,
    amount,
    settleDelay,
    publicKey,
    cancelAfter,
    network = 'testnet',
    rpcUrl,
  } = params

  const wallet = resolveWallet({ wallet: walletInput, seed })
  const xrplWallet = wallet._xrplWallet

  // Reject dust before connecting: an Amount of 0 drops produces a dead
  // channel that burns the source's reserve increment without delivering
  // value, and the ledger would surface this only as a tem*** code.
  if (BigInt(amount) <= 0n) {
    throw new Error(
      `[INVALID_AMOUNT] PaymentChannelCreate amount must be > 0 drops, got ${amount}.`,
    )
  }
  if (settleDelay < 0 || !Number.isFinite(settleDelay)) {
    throw new Error(
      `[INVALID_AMOUNT] PaymentChannelCreate settleDelay must be a non-negative integer, got ${settleDelay}.`,
    )
  }

  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    // PaymentChannelCreate adds an owner object on the source. Preflight the
    // reserve so the caller sees a typed error instead of tecINSUFFICIENT_RESERVE.
    const state = await getReserveState(client, wallet.address)
    if (!state) {
      throw new Error(`[INSUFFICIENT_BALANCE] Account ${wallet.address} is not yet funded.`)
    }
    assertReserveCovers({
      account: wallet.address,
      state,
      addedOwnerObjects: 1,
      paymentDrops: BigInt(amount),
      kind: 'PaymentChannelCreate',
    })

    const channelCreate: any = {
      TransactionType: 'PaymentChannelCreate',
      Account: wallet.address,
      Destination: destination,
      Amount: amount,
      SettleDelay: settleDelay,
      PublicKey: publicKey ?? wallet.publicKey,
      SourceTag: MPP_SOURCE_TAG,
    }

    if (cancelAfter) {
      channelCreate.CancelAfter = channelCancelAfterToRippleTime(cancelAfter)
    }

    const result = await client.submitAndWait(channelCreate, { wallet: xrplWallet })
    const meta = result.result.meta as any

    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`PaymentChannelCreate failed: ${meta?.TransactionResult ?? 'unknown'}`)
    }

    const channelId = extractChannelId(meta)
    const txHash = result.result.hash

    return { channelId, txHash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Fund an existing PayChannel with additional XRP.
 */
export async function fundChannel(params: {
  /** Funder wallet. Preferred over `seed`. */
  wallet?: Wallet
  /** Family seed of the funder. Kept for backward compatibility -- prefer `wallet`. */
  seed?: string
  channelId: string
  amount: string
  network?: NetworkId
  rpcUrl?: string
}): Promise<{ txHash: string }> {
  const { wallet: walletInput, seed, channelId, amount, network = 'testnet', rpcUrl } = params

  const wallet = resolveWallet({ wallet: walletInput, seed })
  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    const channelFund = {
      TransactionType: 'PaymentChannelFund' as const,
      Account: wallet.address,
      Channel: channelId,
      Amount: amount,
      SourceTag: MPP_SOURCE_TAG,
    }

    const result = await client.submitAndWait(channelFund, { wallet: wallet._xrplWallet })
    const meta = result.result.meta as any

    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`PaymentChannelFund failed: ${meta?.TransactionResult ?? 'unknown'}`)
    }

    return { txHash: result.result.hash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Prepare and sign a `PaymentChannelCreate` transaction without
 * submitting it. Returns the hex-encoded `tx_blob` (and the
 * pre-computed transaction hash) that callers feed into the MPP
 * `action: 'open'` credential.
 *
 * Why this helper exists: the open-via-MPP flow signs a tx client-side
 * and ships the blob inside a credential payload -- the server submits
 * it. Without this helper, integrators have to import `xrpl.Client` and
 * `xrpl.Wallet` directly to autofill + sign.
 *
 * Behavior:
 * - Validates `amount` (>= 1 drop) and `settleDelay` (>= 0) before
 *   touching the network -- same checks {@link openChannel} runs.
 * - Runs an owner-reserve preflight (1 added owner object for the new
 *   PayChannel). Surfaces `INSUFFICIENT_RESERVE` early.
 * - When `expiresAt` is set, caps `LastLedgerSequence` so the blob
 *   cannot land past the expiry. This mirrors what the SDK does on
 *   the charge path; the server's `doVerifyOpen` runs the matching
 *   gate on receive. If your challenge has an `expires` field, pass
 *   it here so the two ends agree.
 */
export async function prepareOpenChannelTransaction(params: {
  /** Funder wallet. Preferred over `seed`. */
  wallet?: Wallet
  /** Family seed of the funder. Kept for backward compatibility -- prefer `wallet`. */
  seed?: string
  /** Recipient (channel destination). */
  destination: string
  /** Amount to fund the channel with, in drops. */
  amount: string
  /** Channel settle delay, in seconds. */
  settleDelay: number
  /**
   * Channel public key. Defaults to the funder's wallet public key,
   * which is what most consumers want -- claims are signed with the
   * matching private key.
   */
  publicKey?: string
  /** Optional `CancelAfter` (ripple time, seconds). */
  cancelAfter?: Date | number | string
  /**
   * When set, caps the tx's `LastLedgerSequence` so it expires on-ledger
   * at or before this moment. Use the `challenge.expires` value here
   * when going through the MPP open flow.
   */
  expiresAt?: Date | number | string
  network?: NetworkId
  rpcUrl?: string
}): Promise<{ txBlob: string; txHash: string }> {
  const {
    wallet: walletInput,
    seed,
    destination,
    amount,
    settleDelay,
    publicKey,
    cancelAfter,
    expiresAt,
    network = 'testnet',
    rpcUrl,
  } = params

  if (BigInt(amount) <= 0n) {
    throw new Error(
      `[INVALID_AMOUNT] PaymentChannelCreate amount must be > 0 drops, got ${amount}.`,
    )
  }
  if (settleDelay < 0 || !Number.isFinite(settleDelay)) {
    throw new Error(
      `[INVALID_AMOUNT] PaymentChannelCreate settleDelay must be a non-negative integer, got ${settleDelay}.`,
    )
  }

  const wallet = resolveWallet({ wallet: walletInput, seed })
  const xrplWallet = wallet._xrplWallet

  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    const state = await getReserveState(client, wallet.address)
    if (!state) {
      throw new Error(`[INSUFFICIENT_BALANCE] Account ${wallet.address} is not yet funded.`)
    }
    assertReserveCovers({
      account: wallet.address,
      state,
      addedOwnerObjects: 1,
      paymentDrops: BigInt(amount),
      kind: 'PaymentChannelCreate',
    })

    const tx: any = {
      TransactionType: 'PaymentChannelCreate',
      Account: wallet.address,
      Destination: destination,
      Amount: amount,
      SettleDelay: settleDelay,
      PublicKey: publicKey ?? wallet.publicKey,
      SourceTag: MPP_SOURCE_TAG,
    }
    if (cancelAfter) {
      tx.CancelAfter = channelCancelAfterToRippleTime(cancelAfter)
    }

    const prepared = await client.autofill(tx)

    if (expiresAt !== undefined) {
      const expiresIso =
        expiresAt instanceof Date
          ? expiresAt.toISOString()
          : typeof expiresAt === 'number'
            ? new Date(expiresAt).toISOString()
            : expiresAt
      const currentLedgerIndex = await readCurrentLedgerIndex(client)
      const cap = lastLedgerSequenceFromExpires({ currentLedgerIndex, expiresIso })
      const autofilled = (prepared as { LastLedgerSequence?: number }).LastLedgerSequence
      if (autofilled === undefined || cap < autofilled) {
        ;(prepared as { LastLedgerSequence?: number }).LastLedgerSequence = cap
      }
    }

    const signed = xrplWallet.sign(prepared)
    return { txBlob: signed.tx_blob, txHash: signed.hash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Extract the channel ID from PaymentChannelCreate transaction metadata.
 */
function extractChannelId(meta: any): string {
  const nodes = meta.AffectedNodes ?? []
  for (const node of nodes) {
    const created = node.CreatedNode
    if (created?.LedgerEntryType === 'PayChannel') {
      return created.LedgerIndex
    }
  }
  throw new Error('Could not find PayChannel in transaction metadata')
}
