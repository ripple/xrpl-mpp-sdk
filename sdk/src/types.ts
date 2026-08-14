import type { NetworkId } from './constants.js'
import type { Wallet } from './utils/wallet.js'

/** XRP native currency. */
export type XrpCurrency = 'XRP'

/** Issued currency (IOU) on XRPL. */
export type IssuedCurrency = {
  currency: string
  issuer: string
}

/** Multi-Purpose Token on XRPL. */
export type MPToken = {
  mpt_issuance_id: string
}

/** Any supported XRPL currency type. */
export type XrplCurrency = XrpCurrency | IssuedCurrency | MPToken

/**
 * Snapshot of an MPT holding as the SDK exposes it.
 *
 * Parallel to {@link IssuedCurrency}'s `TrustlineInfo`, but for the MPT path:
 * the holder owns an `MPToken` ledger entry rather than a trustline.
 */
export type MPTHoldingInfo = {
  /** Issuance identifier. */
  mpt_issuance_id: string
  /** Current balance held. `'0'` if just authorised. */
  balance: string
  /**
   * False only when the issuance has `requireAuthorization` and the issuer
   * has not yet authorised this holder.
   */
  authorized: boolean
  /** Issuer has frozen this specific holding (or the whole issuance). */
  locked: boolean
}

/**
 * Snapshot of an MPT issuance owned by an issuer wallet.
 *
 * Returned by {@link Wallet.listIssuedTokens} and useful after
 * {@link Wallet.createToken} to confirm flag state on chain.
 */
export type MPTIssuanceInfo = {
  mpt_issuance_id: string
  issuer: string
  assetScale: number
  /** Total supply currently in circulation. */
  outstandingAmount: string
  /** Hard cap. Defaults to `2^63 - 1` when omitted at create time. */
  maximumAmount: string
  /** Transfer fee in 1/1000 percent (0..50000). 0 means no fee. */
  transferFee: number
  /** Whether the whole issuance is locked. */
  locked: boolean
  flags: {
    canLock: boolean
    requireAuthorization: boolean
    canEscrow: boolean
    canTrade: boolean
    canTransfer: boolean
    canClawback: boolean
  }
  /** Hex-encoded XLS-89 metadata blob, or undefined if not set. */
  metadata?: string
}

/**
 * Discriminated holding view for {@link Wallet.holdsToken} /
 * {@link Wallet.listAcceptedTokens}: an IOU exposes a `currency` + `issuer`
 * pair, an MPT exposes an `mpt_issuance_id`.
 *
 * The `kind` discriminator lets consumers narrow without importing
 * type guards.
 */
export type TokenHolding =
  | ({ kind: 'iou' } & {
      currency: string
      issuer: string
      balance: string
      limit: string
      authorized: boolean
      frozen: boolean
      noRipple: boolean
    })
  | ({ kind: 'mpt' } & MPTHoldingInfo)

/**
 * Outcome of {@link Wallet.acceptToken} -- works for both IOU and MPT paths.
 *
 * - `unchanged`: the trustline / MPToken already exists in the desired state.
 * - `created`: a new ledger entry was created.
 * - `updated`: an existing trustline's limit was updated (IOU only).
 * - `pending_authorization`: the holder side is in place but the issuer has
 *   `requireAuthorization` set and has not signed yet -- payments will fail
 *   until the issuer calls {@link Wallet.authorize}.
 */
export type AcceptTokenResult =
  | { status: 'unchanged' }
  | { status: 'created'; hash: string }
  | { status: 'updated'; hash: string }
  | { status: 'pending_authorization'; hash?: string }

/**
 * Outcome of {@link Wallet.refuseToken}.
 *
 * - `absent`: there was no trustline / MPToken -- nothing happened.
 * - `removed`: the ledger entry has been deleted; the holder's owner
 *   reserve is freed.
 * - `cleared` (IOU only): the TrustSet succeeded but a non-default flag
 *   keeps the entry pinned at limit=0 / balance=0; the reserve stays
 *   locked until the issuer relaxes the flag.
 */
export type RefuseTokenResult =
  | { status: 'absent' }
  | { status: 'removed'; hash: string }
  | { status: 'cleared'; hash: string }

/** Options for {@link Wallet.createToken} (MPTokenIssuanceCreate). */
export type CreateTokenOptions = {
  /**
   * Decimal places. `0` means token is indivisible, `2` means amounts are
   * counted in cents, etc. Range 0..255. @default 0
   */
  assetScale?: number
  /**
   * Hard cap on circulating supply. Decimal string of an integer up to
   * `2^63 - 1`. When omitted, defaults to the protocol max.
   */
  maximumAmount?: string
  /**
   * Transfer fee in 1/1000 percent. Range 0..50000 (= 0..50%). Only valid
   * when {@link CreateTokenOptions.allowTransfer} is true.
   */
  transferFee?: number
  /**
   * Require the issuer to authorise each holder before they can hold a
   * balance. Once set at creation, this flag is **immutable**.
   * @default false
   */
  requireAuthorization?: boolean
  /**
   * Allow the issuer to later lock the whole issuance or specific holders
   * via raw `MPTokenIssuanceSet` transactions. Immutable. The MPP SDK does
   * not expose a Wallet helper for locking -- mint with this flag only if
   * you plan to administer the issuance via raw XRPL tooling.
   * @default false
   */
  allowLock?: boolean
  /**
   * Allow holders to transfer the token to anyone (not just the issuer).
   * Required for any meaningful pay-per-X use case. Immutable.
   * @default true
   */
  allowTransfer?: boolean
  /**
   * Allow the issuer to later claw the token back from holders via raw
   * `Clawback` transactions. Immutable. The MPP SDK does not expose a
   * Wallet helper for clawback -- mint with this flag only if you plan to
   * administer the issuance via raw XRPL tooling.
   * @default false
   */
  allowClawback?: boolean
  /** Allow holders to escrow this token. Immutable. @default false */
  allowEscrow?: boolean
  /** Allow holders to trade this token on the XRPL DEX / AMM. Immutable. @default false */
  allowTrade?: boolean
  /**
   * XLS-89 metadata. May be a JSON-serialisable object (the SDK encodes it
   * to UTF-8 hex) or a pre-encoded hex string. Max 1024 bytes.
   */
  metadata?: string | Record<string, unknown>
}

/** Outcome of {@link Wallet.createToken}. */
export type CreateTokenResult = {
  /** The newly created MPT, ready to pass to other Wallet methods. */
  mpt: MPToken
  /** Submission hash of the `MPTokenIssuanceCreate`. */
  hash: string
}

/**
 * Reference to an existing escrow on the ledger. An escrow is identified
 * by its creator's address plus the `Sequence` of the `EscrowCreate`
 * transaction. The `escrowId` (ledger entry hash) is exposed for
 * convenience but is *not* required to finish or cancel -- XRPL operates
 * on `(owner, offerSequence)`.
 */
export type EscrowReference = {
  /** Creator of the escrow (`Account` on the original `EscrowCreate`). */
  owner: string
  /** `Sequence` of the original `EscrowCreate` transaction. */
  sequence: number
}

/** Options for {@link Wallet.createEscrow}. */
export type CreateEscrowOptions = {
  /** Recipient classic address. */
  destination: string
  /**
   * Amount to lock. XRP drops as a string (e.g. `'1000000'` for 1 XRP),
   * an {@link IssuedCurrency} amount object, or an MPT amount.
   * IOU/MPT escrow requires the network to have the relevant amendments
   * (`TokenEscrow`) enabled.
   */
  amount:
    | string
    | { currency: string; issuer: string; value: string }
    | { mpt_issuance_id: string; value: string }
  /**
   * Earliest moment the escrow can be **finished**. Pass a `Date`, a
   * Unix timestamp in milliseconds, or an ISO-8601 string. The SDK
   * converts it to the XRPL "ripple time" representation internally.
   *
   * At least one of `finishAfter` or `condition` must be set.
   */
  finishAfter?: Date | number | string
  /**
   * Earliest moment the escrow can be **cancelled** (refunded to the
   * creator). Same accepted shapes as `finishAfter`. Must be strictly
   * greater than `finishAfter` when both are provided.
   *
   * **Required for token escrows.** Under the `TokenEscrow` amendment an
   * IOU/MPT escrow with no `cancelAfter` locks on create but can never be
   * finished (the ledger rejects `EscrowFinish` with `tecNO_PERMISSION`),
   * so the SDK rejects such a `createEscrow` upfront. Optional for XRP
   * escrows.
   */
  cancelAfter?: Date | number | string
  /**
   * Hex-encoded crypto-condition (PREIMAGE-SHA-256). Whoever finishes
   * the escrow must supply the matching fulfillment. Use
   * {@link generatePreimageCondition} to mint a fresh pair.
   */
  condition?: string
  /** Optional `DestinationTag` to attach to the escrow. */
  destinationTag?: number
  /** Optional `SourceTag` to attach to the escrow. */
  sourceTag?: number
}

/** Outcome of {@link Wallet.createEscrow}. */
export type CreateEscrowResult = {
  /** Submission hash of the `EscrowCreate`. */
  hash: string
  /** `Sequence` of the submitted `EscrowCreate` -- pass to finish/cancel. */
  sequence: number
  /**
   * Hash of the on-chain Escrow ledger entry (`hashEscrow(owner, sequence)`).
   * Useful for direct ledger lookups and for external systems.
   */
  escrowId: string
}

/** Options for {@link Wallet.finishEscrow}. */
export type FinishEscrowOptions = EscrowReference & {
  /**
   * Hex-encoded crypto-condition that the finisher claims to satisfy.
   * Required when the escrow was created with a `condition`. Must match
   * the original condition byte-for-byte.
   */
  condition?: string
  /**
   * Hex-encoded fulfillment proving the `condition`. Required when the
   * escrow was created with a `condition`.
   */
  fulfillment?: string
}

/** Snapshot of an Escrow ledger entry. */
export type EscrowInfo = {
  /** Hash of the Escrow ledger entry (`hashEscrow(owner, sequence)`). */
  escrowId: string
  /** `Sequence` of the original `EscrowCreate`. */
  sequence: number
  /** Creator (and refund target on cancel). */
  owner: string
  /** Recipient on finish. */
  destination: string
  /**
   * Amount locked. Same shape as on the original `EscrowCreate`:
   * drops string for XRP, IOU/MPT amount object otherwise.
   */
  amount:
    | string
    | { currency: string; issuer: string; value: string }
    | { mpt_issuance_id: string; value: string }
  /** When set, the escrow can only be finished at or after this Date. */
  finishAfter?: Date
  /** When set, the escrow can be cancelled at or after this Date. */
  cancelAfter?: Date
  /** Hex-encoded crypto-condition required to finish, when set. */
  condition?: string
  /** Optional `DestinationTag` recorded on the escrow. */
  destinationTag?: number
  /** Optional `SourceTag` recorded on the escrow. */
  sourceTag?: number
}

/** Pull: client signs tx blob, server submits. Push: client submits, sends hash. */
export type PaymentMode = 'pull' | 'push'

/** Lifecycle event emitted by the client charge flow's `onProgress` callback. */
export type ChargeProgressEvent =
  | { type: 'challenge'; recipient: string; amount: string; currency: string }
  | { type: 'preflight' }
  | { type: 'pathfinding' }
  | {
      type: 'paths_resolved'
      strategy: 'self-issued' | 'direct-trustline' | 'cross-issuer'
      sourceAmountValue: string
      sourceAmountCurrency: string
    }
  | { type: 'signing' }
  | { type: 'signed'; mode: PaymentMode }
  | { type: 'submitting' }
  | { type: 'confirmed'; hash: string }

export type ChargeClientConfig = {
  /** Wallet used to sign the payment. Preferred over `seed`. */
  wallet?: Wallet
  /**
   * Family seed of the payer. Kept for backward compatibility -- prefer
   * `wallet`, which redacts itself on serialisation. A raw seed string cannot
   * be redacted, so never log or persist a config object that carries one.
   */
  seed?: string
  /** Payment mode -- pull (default) or push. */
  mode?: PaymentMode
  /**
   * Run pre-flight validation before signing the transaction.
   *
   * When enabled, checks:
   * - Destination account exists on the ledger
   * - Sufficient XRP balance for reserves, fees, and payment amount
   *   (reserves are queried dynamically from the network via server_state)
   * - Rippling is enabled on the issuer for IOU payments
   *
   * @default true
   */
  preflight?: boolean
  /**
   * Slippage buffer applied to SendMax for IOU payments, in basis points
   * (1 bp = 0.01%). The SendMax sent to the ledger is
   * `source_amount * (1 + slippageBps / 10000)`. Range 0-1000 (max 10%).
   *
   * The default 50 bps (0.5%) covers small intra-block price moves on
   * cross-issuer paths and the standard issuer TransferRate range without
   * overpaying for typical liquidity.
   *
   * @default 50
   */
  slippageBps?: number
  /**
   * Backoff delays (ms) between ripple_path_find retries when the first call
   * returns no alternatives. Default `[1000, 2000, 4000]`. Pass an empty
   * array to disable retries.
   */
  pathFindRetryDelaysMs?: number[]
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
  /** Callback invoked at each lifecycle stage. */
  onProgress?: (event: ChargeProgressEvent) => void
  /**
   * Client-side authorization guardrails, enforced against the 402 challenge
   * before anything is signed or submitted (mpp.dev, Amount verification: the
   * client must verify amount, recipient, and currency before authorizing).
   * All are optional; when omitted the SDK signs whatever the server asks and
   * the agent-policy layer owns limits. When set, a challenge outside these
   * bounds throws a `CHALLENGE_REJECTED` error and fails closed.
   */
  /** Only sign when the challenge recipient equals this address (or is in this allowlist). */
  expectedRecipient?: string | string[]
  /**
   * Reject a challenge whose `amount` exceeds this ceiling. Same units as the
   * challenge `amount` (drops for XRP, base units for IOU/MPT).
   */
  maxAmount?: string
  /** Reject a challenge whose `currency` string is not in this allowlist. */
  allowedCurrencies?: string[]
}

export type ChargeServerConfig = {
  /** Recipient XRPL address. */
  recipient: string
  /** Expected currency. */
  currency?: XrplCurrency
  /**
   * Auto-create trustline on the recipient account for IOUs if missing.
   * Requires a seed/wallet to sign the TrustSet transaction.
   * @default false
   */
  autoTrustline?: boolean
  /** Maximum balance willing to hold from issuer when auto-creating trustlines. @default '10000' */
  autoTrustlineLimit?: string
  /**
   * Auto-authorize MPT holding on the recipient account if missing.
   * Requires a seed/wallet to sign the MPTokenAuthorize transaction.
   * @default false
   */
  autoMPTAuthorize?: boolean
  /**
   * Recipient wallet -- required if autoTrustline or autoMPTAuthorize is set.
   * Preferred over `seed`.
   */
  wallet?: Wallet
  /**
   * Recipient family seed -- required if autoTrustline or autoMPTAuthorize is
   * set. Kept for backward compatibility -- prefer `wallet`. A raw seed string
   * cannot be redacted, so never log or persist a config object carrying one.
   */
  seed?: string
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

export type ChannelClientConfig = {
  /** Funder wallet. Preferred over `seed`. */
  wallet?: Wallet
  /**
   * Family seed of the channel funder. Kept for backward compatibility --
   * prefer `wallet`. A raw seed string cannot be redacted, so never log or
   * persist a config object that carries one.
   */
  seed?: string
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

export type ChannelServerConfig = {
  /**
   * Channel funder's public key, used as an allowlist and as the fallback
   * verification key. Claims verify against the channel's on-ledger
   * `PublicKey` when available, so ledger state is the source of truth.
   */
  publicKey: string
  /**
   * Address this server expects to be paid: the channel's on-ledger
   * `Destination`. A channel pointing anywhere else is rejected with
   * `CHANNEL_DESTINATION_MISMATCH`, since its claims could never be redeemed
   * here.
   *
   * Defaults to the address of `wallet` / `seed` when one is supplied. Leaving
   * all three unset skips the check and emits a warning: vouchers would then be
   * honoured for a channel that pays someone else.
   */
  recipient?: string
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}
