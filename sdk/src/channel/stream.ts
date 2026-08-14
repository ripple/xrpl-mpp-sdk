import { dropsToXrp, signPaymentChannelClaim } from 'xrpl'
import type { Wallet } from '../utils/wallet.js'

/**
 * Resolve the private key used to sign claims, accepting either a
 * {@link Wallet} (preferred) or a raw hex string for backward compatibility.
 */
function resolvePrivateKey(input: { wallet?: Wallet; privateKey?: string }): string {
  if (input.wallet) return input.wallet.privateKey
  if (input.privateKey) return input.privateKey
  throw new Error('[xrpl-mpp-sdk] ChannelStream/ChannelSession require a wallet or privateKey.')
}

/**
 * Common constructor input for both {@link ChannelStream} and
 * {@link ChannelSession}. Exactly one of `wallet` or `privateKey` must be
 * provided -- `wallet` is preferred so the secret never appears at the
 * call site.
 */
export type ChannelStreamSigner =
  | { wallet: Wallet; privateKey?: never }
  | { wallet?: never; privateKey: string }

/** Pay-per-token streaming via PayChannel claims. */
export class ChannelStream {
  readonly channelId: string
  readonly #privateKey: string
  readonly dropsPerUnit: bigint

  private cumulative = 0n
  private units = 0n
  private granularity: bigint
  private lastSignature = ''
  private lastSignedCumulative = 0n

  constructor(
    params: {
      channelId: string
      /** Cost per unit (token/byte/chunk) in drops. */
      dropsPerUnit: string | bigint
      /** Sign a new claim every N units. @default 1 */
      granularity?: number
    } & ChannelStreamSigner,
  ) {
    this.channelId = params.channelId
    this.#privateKey = resolvePrivateKey({
      ...(params.wallet ? { wallet: params.wallet } : {}),
      ...(params.privateKey ? { privateKey: params.privateKey } : {}),
    })
    this.dropsPerUnit = BigInt(params.dropsPerUnit)
    this.granularity = BigInt(params.granularity ?? 1)
  }

  /**
   * Record consumption of units (tokens, bytes, chunks).
   * Returns a signed claim if the granularity threshold was crossed.
   */
  tick(units = 1): ChannelClaim | null {
    this.units += BigInt(units)
    this.cumulative = this.units * this.dropsPerUnit

    const prevBucket = (this.units - BigInt(units)) / this.granularity
    const currBucket = this.units / this.granularity

    if (currBucket > prevBucket || this.lastSignedCumulative === 0n) {
      return this.sign()
    }
    return null
  }

  /**
   * Force-sign a claim for the current cumulative amount.
   */
  sign(): ChannelClaim {
    const amount = this.cumulative.toString()
    // signPaymentChannelClaim expects XRP, not drops -- it internally calls xrpToDrops.
    const amountXrp = dropsToXrp(amount).toString()
    const signature = signPaymentChannelClaim(this.channelId, amountXrp, this.#privateKey)

    this.lastSignature = signature
    this.lastSignedCumulative = this.cumulative

    return {
      channelId: this.channelId,
      amount,
      signature,
    }
  }

  /**
   * Get the latest signed claim (for final settlement).
   */
  latest(): ChannelClaim | null {
    if (!this.lastSignature) return null
    return {
      channelId: this.channelId,
      amount: this.lastSignedCumulative.toString(),
      signature: this.lastSignature,
    }
  }

  /** Current cumulative amount in drops. */
  get currentAmount(): string {
    return this.cumulative.toString()
  }

  /** Total units consumed. */
  get totalUnits(): string {
    return this.units.toString()
  }
}

/** Session billing over a single PayChannel. */
export class ChannelSession {
  readonly channelId: string
  readonly dropsPerRequest: bigint

  #requestCount = 0n
  #stream: ChannelStream

  constructor(
    params: {
      channelId: string
      /** Cost per request in drops. */
      dropsPerRequest: string | bigint
      /** Sign every N requests. @default 1 */
      granularity?: number
    } & ChannelStreamSigner,
  ) {
    this.channelId = params.channelId
    this.dropsPerRequest = BigInt(params.dropsPerRequest)
    this.#stream = new ChannelStream({
      channelId: params.channelId,
      dropsPerUnit: params.dropsPerRequest,
      ...(params.granularity !== undefined ? { granularity: params.granularity } : {}),
      ...(params.wallet ? { wallet: params.wallet } : { privateKey: params.privateKey as string }),
    } as ConstructorParameters<typeof ChannelStream>[0])
  }

  /**
   * Record a paid request. Returns a signed claim if threshold crossed.
   */
  pay(): ChannelClaim | null {
    this.#requestCount++
    return this.#stream.tick(1)
  }

  /**
   * Force-sign the current state for settlement.
   */
  settle(): ChannelClaim {
    return this.#stream.sign()
  }

  /**
   * Get the latest signed claim.
   */
  latest(): ChannelClaim | null {
    return this.#stream.latest()
  }

  /** Number of paid requests so far. */
  get requests(): number {
    return Number(this.#requestCount)
  }

  /** Current cumulative drops committed. */
  get currentAmount(): string {
    return this.#stream.currentAmount
  }
}

/** A signed PayChannel claim. */
export type ChannelClaim = {
  channelId: string
  amount: string
  signature: string
}
