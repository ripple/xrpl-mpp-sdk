import { Errors } from 'mppx'

/**
 * Mapping from XRPL transaction engine results (tec/tem/ter/tef) to the SDK's
 * typed error codes. Sub-headings group related codes; the comments next to a
 * specific code call out a non-obvious mapping.
 */
export const TEC_RESULT_MAP: Record<string, string> = {
  // Payment failures
  tecPATH_DRY: 'PAYMENT_PATH_FAILED',
  // tecPATH_PARTIAL is a path/liquidity issue, not a sender-balance shortfall.
  tecPATH_PARTIAL: 'PAYMENT_PATH_FAILED',
  tecUNFUNDED_PAYMENT: 'INSUFFICIENT_BALANCE',
  tecNO_DST: 'RECIPIENT_NOT_FOUND',
  // Trustline / authorisation
  tecNO_AUTH: 'TRUSTLINE_NOT_AUTHORIZED',
  tecNO_LINE: 'MISSING_TRUSTLINE',
  tecNO_LINE_INSUF_RESERVE: 'INSUFFICIENT_RESERVE',
  tecNO_LINE_REDUNDANT: 'MISSING_TRUSTLINE',
  tecFROZEN: 'TRUSTLINE_FROZEN',
  // Reserve / fee
  tecINSUFFICIENT_RESERVE: 'INSUFFICIENT_RESERVE',
  tecINSUFF_FEE: 'INSUFFICIENT_FEE',
  terINSUF_FEE_B: 'INSUFFICIENT_FEE',
  // Sequence / submission
  tefPAST_SEQ: 'SUBMISSION_FAILED',
  tefALREADY: 'SUBMISSION_FAILED',
  tefBAD_AUTH: 'INVALID_SIGNATURE',
  tefMASTER_DISABLED: 'INVALID_SIGNATURE',
  // Validation
  temBAD_AMOUNT: 'INVALID_AMOUNT',
  // tecNO_PERMISSION has more than one cause and the code alone does not say
  // which. On a Payment to an account with lsfDepositAuth set it means the
  // destination refuses unsolicited funds; on the MPT path it means the holder
  // is not authorised for an lsfMPTRequireAuth issuance. The table cannot tell
  // them apart, so it gives the answer that holds either way -- `mapTecResult`
  // refines it to MPT_NOT_AUTHORIZED when the caller knows the payment moved an
  // MPT. Reporting a destination's configuration as an MPT problem sends the
  // operator looking in the wrong place.
  tecNO_PERMISSION: 'DESTINATION_PERMISSION_DENIED',
  // MPT-specific runtime failures observed at submit time. `tecMPT_LOCKED`
  // means the MPT issuance (or the holder's MPToken) was locked by the
  // issuer between path-finding and submit. `tecMPT_NOT_AUTHORIZED` means
  // the issuer never authorised this holder for an `RequireAuth` issuance.
  tecMPT_LOCKED: 'MPT_LOCKED',
  tecMPT_NOT_AUTHORIZED: 'MPT_NOT_AUTHORIZED',
  // tecCRYPTOCONDITION_ERROR fires when the supplied fulfillment does not
  // satisfy the on-chain condition (or is malformed).
  //
  // tecNO_TARGET covers a missing Escrow *and* a missing PayChannel, so the
  // table gives the escrow reading and `mapTecResult` narrows it to
  // CHANNEL_NOT_FOUND when the caller says the operation was on a channel.
  // Reporting a deleted channel as a missing escrow is how a close that raced
  // another close reads today.
  tecCRYPTOCONDITION_ERROR: 'ESCROW_INVALID_FULFILLMENT',
  tecNO_TARGET: 'ESCROW_NOT_FOUND',
}

export type XrplErrorCode =
  | 'PAYMENT_PATH_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_FEE'
  | 'INSUFFICIENT_RESERVE'
  | 'RECIPIENT_NOT_FOUND'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'TRUSTLINE_REQUIRES_AUTH'
  | 'TRUSTLINE_FROZEN'
  | 'TRUSTLINE_HAS_BALANCE'
  | 'MISSING_TRUSTLINE'
  | 'ISSUER_GLOBAL_FROZEN'
  | 'INVALID_AMOUNT'
  | 'CHANNEL_EXPIRED'
  | 'CHANNEL_NOT_FOUND'
  | 'CHANNEL_EXHAUSTED'
  | 'CHANNEL_DESTINATION_MISMATCH'
  | 'CHANNEL_CLOSING'
  | 'CHANNEL_SETTLE_DELAY_TOO_SHORT'
  | 'INVALID_SIGNATURE'
  | 'REPLAY_DETECTED'
  | 'AMOUNT_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'SOURCE_MISMATCH'
  | 'SUBMISSION_FAILED'
  | 'MPT_NOT_AUTHORIZED'
  | 'DESTINATION_PERMISSION_DENIED'
  | 'MPT_LOCKED'
  | 'MPT_HAS_BALANCE'
  | 'MPT_ISSUANCE_NOT_FOUND'
  | 'MPT_NOT_ISSUER'
  | 'MPT_INVALID_METADATA'
  | 'ESCROW_NOT_FOUND'
  | 'ESCROW_NOT_READY'
  | 'ESCROW_INVALID_FULFILLMENT'
  | 'ESCROW_FAILED'
  | 'CHALLENGE_REJECTED'

/** What the failing transaction was moving, where that changes a result's meaning. */
export type TecContext = {
  /** True when the Payment carried an MPT, which narrows `tecNO_PERMISSION`. */
  mpt?: boolean
  /**
   * Which ledger object the failing transaction acted on.
   *
   * `tecNO_TARGET` is reported for a missing Escrow *and* a missing PayChannel,
   * so the code alone cannot say which was absent. Pass this wherever the
   * operation is known.
   */
  operation?: 'payment' | 'channel' | 'escrow'
}

export function mapTecResult(tecResult: string, context?: TecContext): XrplErrorCode | undefined {
  if (tecResult === 'tecNO_PERMISSION' && context?.mpt) return 'MPT_NOT_AUTHORIZED'
  if (tecResult === 'tecNO_TARGET' && context?.operation === 'channel') return 'CHANNEL_NOT_FOUND'
  return TEC_RESULT_MAP[tecResult] as XrplErrorCode | undefined
}

export function verificationFailed(
  code: XrplErrorCode,
  detail: string,
  tecResult?: string,
): Errors.VerificationFailedError {
  const parts = [`[${code}] ${detail}`]
  if (tecResult) parts.push(`(tecResult: ${tecResult})`)
  return new Errors.VerificationFailedError({ reason: parts.join(' ') })
}

export function insufficientBalance(
  detail: string,
  tecResult?: string,
): Errors.InsufficientBalanceError {
  const reason = tecResult ? `[INSUFFICIENT_BALANCE] ${detail} (tecResult: ${tecResult})` : detail
  return new Errors.InsufficientBalanceError({ reason })
}

export function invalidSignature(detail: string): Errors.InvalidSignatureError {
  return new Errors.InvalidSignatureError({ reason: `[INVALID_SIGNATURE] ${detail}` })
}

/**
 * Client-side refusal to authorize a payment whose challenge terms fall
 * outside the caller's configured guardrails (`expectedRecipient`,
 * `maxAmount`, `allowedCurrencies`).
 *
 * Per mpp.dev (Amount verification), clients must verify the amount,
 * recipient, and currency before authorizing. This surfaces that refusal as
 * a typed error thrown before any transaction is signed or submitted.
 */
export function challengeRejected(detail: string): Error {
  return new Error(`[CHALLENGE_REJECTED] ${detail}`)
}

export function channelNotFound(channelId: string): Errors.ChannelNotFoundError {
  return new Errors.ChannelNotFoundError({
    reason: `[CHANNEL_NOT_FOUND] Channel ${channelId} does not exist`,
  })
}

export function channelClosed(channelId: string): Errors.ChannelClosedError {
  return new Errors.ChannelClosedError({
    reason: `[CHANNEL_EXPIRED] Channel ${channelId} is expired or closed`,
  })
}

/**
 * The channel's on-ledger `Destination` is not the configured recipient, so
 * any claim against it would be unredeemable by this server.
 */
export function channelDestinationMismatch(
  channelId: string,
  expected: string,
  actual: string,
): Errors.VerificationFailedError {
  return new Errors.VerificationFailedError({
    reason:
      `[CHANNEL_DESTINATION_MISMATCH] Channel ${channelId} pays ${actual}, not the configured ` +
      `recipient ${expected}. Claims against it could never be redeemed by this server.`,
  })
}

/**
 * The channel is still open but close enough to closing that a new claim may
 * not be redeemable before it settles.
 *
 * Distinct from `CHANNEL_EXPIRED`, which means the window has already passed:
 * this is the safety margin in front of it.
 */
export function channelClosing(channelId: string, closesAt: string): Errors.ChannelClosedError {
  return new Errors.ChannelClosedError({
    reason:
      `[CHANNEL_CLOSING] Channel ${channelId} closes at ${closesAt}, which is inside the ` +
      'settlement safety margin. A claim accepted now might not be redeemable before the ' +
      'channel settles, so it is refused.',
  })
}

/**
 * The channel's `SettleDelay` is shorter than the server requires.
 *
 * A short delay means the funder can close and reclaim unredeemed value faster
 * than the server can notice and submit a claim.
 */
export function channelSettleDelayTooShort(
  channelId: string,
  settleDelay: number,
  minimum: number,
): Errors.VerificationFailedError {
  return new Errors.VerificationFailedError({
    reason:
      `[CHANNEL_SETTLE_DELAY_TOO_SHORT] Channel ${channelId} has SettleDelay ${settleDelay}s, ` +
      `below the required minimum of ${minimum}s. The funder could close and reclaim ` +
      'unredeemed value faster than this server can detect it and submit a claim.',
  })
}

export function channelExhausted(
  channelId: string,
  cumulative: bigint,
  available: bigint,
): Errors.AmountExceedsDepositError {
  return new Errors.AmountExceedsDepositError({
    reason: `[CHANNEL_EXHAUSTED] Cumulative ${cumulative} drops on channel ${channelId} exceeds available balance ${available} drops -- top up via PaymentChannelFund or reset cumulative.`,
  })
}

export function malformedCredential(detail: string): Errors.MalformedCredentialError {
  return new Errors.MalformedCredentialError({ reason: detail })
}

export function replayDetected(identifier: string): Errors.VerificationFailedError {
  return new Errors.VerificationFailedError({
    reason: `[REPLAY_DETECTED] Credential already used: ${identifier}`,
  })
}

/**
 * Map a raw XRPL transaction engine result to the appropriate MPP error.
 *
 * `context` is optional and only narrows results whose meaning depends on what
 * the transaction carried. Pass it wherever the failing transaction is in hand.
 */
export function fromTecResult(
  tecResult: string,
  detail?: string,
  context?: TecContext,
): Errors.VerificationFailedError | Errors.InsufficientBalanceError {
  const code = mapTecResult(tecResult, context)
  const message = detail ?? `Transaction failed with ${tecResult}`

  if (code === 'INSUFFICIENT_BALANCE') {
    return insufficientBalance(message, tecResult)
  }

  // Naming the usual cause without asserting it: the result does not carry one,
  // and only reading the destination's lsfDepositAuth flag would settle it.
  if (code === 'DESTINATION_PERMISSION_DENIED') {
    return verificationFailed(
      code,
      `${message}. The sender lacks permission for this operation. On a ` +
        'payment the usual cause is deposit authorization (lsfDepositAuth) on ' +
        'the recipient, which accepts funds only from preauthorized senders -- a ' +
        'configuration condition on the recipient rather than a problem with ' +
        'the payment. The ledger also reports it for an EscrowFinish attempted ' +
        'before FinishAfter. The result code does not say which.',
      tecResult,
    )
  }

  // Measured on testnet: an issued-currency Payment fails with tecPATH_DRY when
  // the recipient has no trustline, when either side's line is frozen, and when
  // the issuer has global freeze. The codes naming those conditions
  // individually -- tecNO_LINE, tecFROZEN -- belong to the offer path and never
  // reach here, so this result carries all of them and has to name them.
  if (code === 'PAYMENT_PATH_FAILED') {
    return verificationFailed(
      code,
      `${message}. No path could deliver the amount. For an issued currency the ` +
        'usual causes are the recipient holding no trustline to the issuer, a ' +
        'freeze on either side of a trustline, global freeze on the issuer, or ' +
        'rippling not enabled on the issuer. The result code does not say which.',
      tecResult,
    )
  }

  return verificationFailed(code ?? 'SUBMISSION_FAILED', message, tecResult)
}
