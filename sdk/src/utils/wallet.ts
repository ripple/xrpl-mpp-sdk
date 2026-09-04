/**
 * Wallet abstraction for the XRPL MPP SDK.
 *
 * Wraps the underlying xrpl.js {@link XrplWallet} so consumers never need to
 * import from `xrpl` directly. Exposes:
 * - construction from seed, random generation, faucet funding,
 * - the public fields needed to sign and identify the holder,
 * - PayChannel claim signing (drops in -> hex signature out),
 * - token-level operations (accept / refuse, transfer, issue, freeze,
 *   authorize, clawback, ...) that hide every TrustSet / MPTokenAuthorize
 *   / MPTokenIssuanceCreate detail. The methods are polymorphic over
 *   {@link IssuedCurrency} | {@link MPToken}: the SDK dispatches to the
 *   right XRPL object internally.
 */

import { Client, signPaymentChannelClaim, Wallet as XrplWallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import type {
  AcceptTokenResult,
  CreateEscrowOptions,
  CreateEscrowResult,
  CreateTokenOptions,
  CreateTokenResult,
  EscrowInfo,
  EscrowReference,
  FinishEscrowOptions,
  IssuedCurrency,
  MPTHoldingInfo,
  MPTIssuanceInfo,
  MPToken,
  RefuseTokenResult,
  TokenHolding,
} from '../types.js'
import { dropsToXrpString } from './amount.js'
import { isMPT } from './currency.js'
import { cancelEscrow, createEscrow, finishEscrow, getEscrow, listEscrows } from './escrow.js'
import {
  authorizeMPTHolder,
  createMPTIssuance,
  getMPTHolding,
  issueMPTPayment,
  listMPTHoldings,
  listMPTIssuances,
  removeMPTHolding,
  setMPTHolding,
} from './mpt.js'
import { assertSecureRpcUrl } from './transport.js'
import {
  ASF_ALLOW_TRUSTLINE_LOCKING,
  ASF_DEFAULT_RIPPLE,
  ASF_REQUIRE_AUTH,
  authorizeTrustline,
  getTrustline,
  issuePayment,
  listTrustlines,
  removeTrustline,
  type SetTrustlineOptions,
  setAccountFlag,
  setTrustline,
  type TrustlineInfo,
} from './trustline.js'

/** Supported XRPL signing algorithms. */
export type WalletAlgorithm = 'ed25519' | 'ecdsa-secp256k1'

/** Common network selection accepted by every Wallet method that hits the ledger. */
export type NetworkOptions = {
  /** XRPL network. @default 'testnet' */
  network?: NetworkId
  /** Custom WebSocket RPC URL. Overrides `network` when present. */
  rpcUrl?: string
}

/** Options for {@link Wallet.fromFaucet}. */
export type FromFaucetOptions = {
  /** XRPL network. Mainnet is rejected -- there is no faucet. @default 'testnet' */
  network?: Exclude<NetworkId, 'mainnet'>
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

/**
 * Options for token-level holder operations on Wallet.
 *
 * The trustline-specific keys (`limit`, `noRipple`) are silently ignored when
 * the currency is an MPT -- MPT semantics don't expose either knob.
 */
export type TokenOptions = NetworkOptions & SetTrustlineOptions

/** Either kind of issued asset accepted by the polymorphic Wallet methods. */
export type Token = IssuedCurrency | MPToken

/**
 * Attach redacted serialisation hooks to an xrpl.js Wallet in place.
 *
 * An xrpl.js `Wallet` stores `seed`, `privateKey` and `publicKey` as ordinary
 * enumerable fields, so `JSON.stringify` on one emits the seed in full and any
 * structured logger that deep-serialises it persists key material. Our own
 * wrapper keeps the handle in a `#private` field and is therefore safe, but the
 * raw object escapes through the internal accessors, and a consumer only has to
 * log it once.
 *
 * The hooks are defined non-enumerable and non-writable so the object's shape
 * is unchanged for xrpl.js -- `JSON.stringify` honours `toJSON` regardless of
 * enumerability -- while `JSON.stringify`, `util.inspect` and template
 * interpolation all yield public data only.
 */
function redactWalletSerialization(wallet: XrplWallet): XrplWallet {
  // Hide the secrets from enumeration. `toJSON` covers JSON.stringify and the
  // inspect hook covers console output, but neither is consulted by
  // `structuredClone`, object spread or `Object.keys`, which walk own
  // enumerable properties directly. Enumerability is the only lever that stops
  // all three at once; the values stay readable by property access, which is
  // how xrpl.js and our own signing helpers reach them.
  for (const secret of ['seed', 'privateKey'] as const) {
    const existing = Object.getOwnPropertyDescriptor(wallet, secret)
    if (existing?.configurable) {
      Object.defineProperty(wallet, secret, { ...existing, enumerable: false })
    }
  }

  const hidden = { enumerable: false, writable: false, configurable: false }
  Object.defineProperties(wallet, {
    toJSON: {
      value: () => ({ address: wallet.classicAddress, publicKey: wallet.publicKey }),
      ...hidden,
    },
    toString: { value: () => `Wallet(${wallet.classicAddress})`, ...hidden },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value: () =>
        `Wallet { address: '${wallet.classicAddress}', publicKey: '${wallet.publicKey}' }`,
      ...hidden,
    },
  })
  return wallet
}

/**
 * XRPL wallet handle.
 *
 * Holds an xrpl.js Wallet internally. The internal handle is intentionally
 * kept private so the SDK can swap signing backends (HSM, KMS, browser
 * keyring) later without breaking consumer code.
 *
 * Serialising this object never emits key material: `toJSON`, `toString` and
 * the Node inspect hook all return address and public key only. The same hooks
 * are attached to the wrapped xrpl.js wallet, so the raw handle exposed by
 * {@link Wallet.unsafeXrplWallet} is redacted too.
 */
export class Wallet {
  readonly #internal: XrplWallet
  /**
   * Per-wallet write queue. XRPL assigns a `Sequence` per account; submitting
   * two transactions concurrently from the same wallet leads to one of them
   * being rejected with `tefPAST_SEQ` once the first lands. The queue chains
   * every mutating Wallet call so users can `Promise.all([...])` freely
   * without thinking about sequence collisions. Read-only calls
   * (`holdsToken`, `listAcceptedTokens`) bypass the queue.
   */
  #writeQueue: Promise<unknown> = Promise.resolve()

  private constructor(internal: XrplWallet) {
    this.#internal = redactWalletSerialization(internal)
  }

  /**
   * Run a write operation under the per-wallet serialisation queue. Each
   * call opens its own short-lived xrpl.Client. An error in one operation
   * does not block subsequent ones (we swallow it on the queue chain only).
   */
  async #submit<T>(options: NetworkOptions, fn: (client: Client) => Promise<T>): Promise<T> {
    const run = (): Promise<T> => withClient(options, fn)
    const next = this.#writeQueue.then(run, run)
    this.#writeQueue = next.catch(() => undefined)
    return next
  }

  /** XRPL classic address (r...). */
  get address(): string {
    return this.#internal.classicAddress
  }

  /** Hex-encoded public key. */
  get publicKey(): string {
    return this.#internal.publicKey
  }

  /**
   * Hex-encoded private key. Treat as secret.
   *
   * Exposed for advanced use cases (custom signing flows). Prefer the
   * higher-level signing helpers on this class when available.
   */
  get privateKey(): string {
    return this.#internal.privateKey
  }

  /**
   * Family seed (s...). Treat as secret.
   *
   * May be `undefined` for wallets derived from a raw private key with no
   * known seed.
   */
  get seed(): string | undefined {
    return this.#internal.seed
  }

  /**
   * @internal
   * Underlying xrpl.js Wallet. Used by the SDK internals to autofill / sign
   * transactions. Not part of the public API -- subject to change.
   *
   * **Never log, serialise, or store the returned object.** Unlike this class,
   * an xrpl.js `Wallet` keeps `seed` and `privateKey` as ordinary enumerable
   * fields, so `JSON.stringify` on it emits the seed in full. Prefer
   * {@link unsafeXrplWallet}, whose name says so at the call site.
   */
  get _xrplWallet(): XrplWallet {
    return this.#internal
  }

  /**
   * Underlying xrpl.js Wallet, for callers that need raw signing access.
   *
   * Named to be visible in review: the returned object serialises its seed and
   * private key in plain text. Keep it on the stack, never in a log line, an
   * error, a cache, or a structured-logging context.
   */
  get unsafeXrplWallet(): XrplWallet {
    return this.#internal
  }

  /**
   * Redacted view. Address and public key only -- both are public on-ledger
   * data.
   *
   * Defined so that `JSON.stringify(wallet)` cannot become a seed leak if the
   * private `#internal` field is ever refactored into a public one. Without an
   * explicit `toJSON`, non-enumerability is the only thing standing between a
   * structured logger and the key material, and that is an implementation
   * detail rather than a control.
   */
  toJSON(): { address: string; publicKey: string } {
    return { address: this.address, publicKey: this.publicKey }
  }

  /** Redacted string form, so template interpolation cannot leak a secret. */
  toString(): string {
    return `Wallet(${this.address})`
  }

  /** Redacted `util.inspect` / console output. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Wallet { address: '${this.address}', publicKey: '${this.publicKey}' }`
  }

  /** Construct a wallet from a family seed (s... / sEd...). */
  static fromSeed(seed: string): Wallet {
    return new Wallet(XrplWallet.fromSeed(seed))
  }

  /** Generate a brand-new random wallet. Defaults to ed25519. */
  static generate(algorithm: WalletAlgorithm = 'ed25519'): Wallet {
    // xrpl.js exposes its `ECDSA` enum only via `import ECDSA from 'xrpl/dist/npm/ECDSA'`,
    // which isn't a stable named export of the package barrel. The enum's runtime
    // values are exactly the strings 'ed25519' / 'ecdsa-secp256k1', so we cast.
    return new Wallet(XrplWallet.generate(algorithm as never))
  }

  /**
   * Create a wallet and fund it via the network's faucet.
   *
   * Only available on testnet and devnet -- mainnet has no faucet and will
   * throw. The function opens a short-lived xrpl.js Client just for the
   * faucet round-trip and disconnects before returning.
   */
  static async fromFaucet(options: FromFaucetOptions = {}): Promise<Wallet> {
    const network = options.network ?? 'testnet'
    if ((network as NetworkId) === 'mainnet') {
      throw new Error('[xrpl-mpp-sdk] Cannot fund a wallet from a faucet on mainnet.')
    }
    const rpcUrl = options.rpcUrl ?? XRPL_RPC_URLS[network]
    const client = new Client(rpcUrl)
    await client.connect()
    try {
      const { wallet } = await client.fundWallet()
      return new Wallet(wallet)
    } finally {
      await client.disconnect()
    }
  }

  /**
   * Top up this wallet from the network's faucet.
   *
   * Useful when you generated a wallet locally (`Wallet.generate()`) and want
   * to fund it later, or to retry a payment that previously failed for lack
   * of XRP. Same testnet/devnet restrictions as {@link Wallet.fromFaucet}.
   */
  async fundFromFaucet(options: FromFaucetOptions = {}): Promise<void> {
    const network = options.network ?? 'testnet'
    if ((network as NetworkId) === 'mainnet') {
      throw new Error('[xrpl-mpp-sdk] Cannot fund a wallet from a faucet on mainnet.')
    }
    const rpcUrl = options.rpcUrl ?? XRPL_RPC_URLS[network]
    const client = new Client(rpcUrl)
    await client.connect()
    try {
      await client.fundWallet(this.#internal)
    } finally {
      await client.disconnect()
    }
  }

  /**
   * Sign a cumulative PayChannel claim.
   *
   * @param channelId 64-hex-character channel ID returned by `openChannel`.
   * @param drops Cumulative claim amount, in drops.
   * @returns Hex-encoded signature suitable for `PaymentChannelClaim` /
   * off-chain voucher payloads.
   */
  signChannelClaim(channelId: string, drops: string): string {
    const xrp = dropsToXrpString(drops)
    return signPaymentChannelClaim(channelId, xrp, this.#internal.privateKey)
  }

  /**
   * Prepare and sign a `PaymentChannelCreate` transaction for use in
   * the MPP `action: 'open'` flow. Returns the hex-encoded `tx_blob`
   * (and pre-computed transaction hash) without submitting -- the
   * server submits the blob when it receives the credential.
   *
   * Thin convenience wrapper around `prepareOpenChannelTransaction`
   * from `xrpl-mpp-sdk/channel/client`.
   *
   * Pass `expiresAt` (the credential `challenge.expires` value) to
   * cap `LastLedgerSequence` so the blob cannot land past challenge
   * expiry; the server runs the matching gate on receive.
   */
  async signOpenChannelTransaction(
    options: {
      destination: string
      amount: string
      settleDelay: number
      publicKey?: string
      cancelAfter?: Date | number | string
      expiresAt?: Date | number | string
    } & NetworkOptions,
  ): Promise<{ txBlob: string; txHash: string }> {
    const { prepareOpenChannelTransaction } = await import('../channel/client/Channel.js')
    return prepareOpenChannelTransaction({ wallet: this, ...options })
  }

  // ===== Holder operations =====

  /**
   * Opt in to receive a token. For an IOU this creates (or updates) the
   * trustline; for an MPT this submits the holder-side `MPTokenAuthorize`.
   *
   * Idempotent: returns `unchanged` when the holding already exists in the
   * desired state. Returns `pending_authorization` when the issuer has
   * `requireAuthorization` and has not yet signed -- the holder side is in
   * place but cannot hold a balance until the issuer calls
   * {@link Wallet.authorize} from their side.
   *
   * The `limit` / `noRipple` options of {@link TokenOptions} apply to IOUs
   * only; they are silently ignored for MPT.
   */
  async acceptToken(token: Token, options: TokenOptions = {}): Promise<AcceptTokenResult> {
    if (isMPT(token)) {
      return this.#submit(options, (client) => setMPTHolding(client, this.#internal, token))
    }
    return this.#submit(options, (client) =>
      setTrustline(client, this.#internal, token, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.noRipple !== undefined ? { noRipple: options.noRipple } : {}),
      }),
    )
  }

  /**
   * Stop holding a token. Refuses to submit if the holding still has a
   * non-zero balance (send the balance back to the issuer first, or have
   * the issuer claw it back).
   *
   * For IOUs the result distinguishes `removed` (trustline deleted, owner
   * reserve freed) from `cleared` (TrustSet succeeded but a non-default
   * flag keeps the entry pinned). For MPTs only `absent` / `removed` apply.
   */
  async refuseToken(token: Token, options: NetworkOptions = {}): Promise<RefuseTokenResult> {
    if (isMPT(token)) {
      return this.#submit(options, (client) => removeMPTHolding(client, this.#internal, token))
    }
    return this.#submit(options, (client) => removeTrustline(client, this.#internal, token))
  }

  /** Read this wallet's current state for a given token. Returns null if not held. */
  async holdsToken(
    token: Token,
    options: NetworkOptions = {},
  ): Promise<TrustlineInfo | MPTHoldingInfo | null> {
    if (isMPT(token)) {
      return withClient(options, (client) => getMPTHolding(client, this.address, token))
    }
    return withClient(options, (client) => getTrustline(client, this.address, token))
  }

  /**
   * List every token (IOU and MPT) this wallet has accepted. Each entry is
   * tagged with `kind: 'iou' | 'mpt'` so consumers can narrow without a
   * separate type guard.
   *
   * Performs two RPC round-trips in parallel (`account_lines` for IOUs and
   * `account_objects type=mptoken` for MPTs).
   */
  async listAcceptedTokens(options: NetworkOptions = {}): Promise<TokenHolding[]> {
    return withClient(options, async (client) => {
      const [trustlines, mpts] = await Promise.all([
        listTrustlines(client, this.address),
        listMPTHoldings(client, this.address),
      ])
      const iouEntries: TokenHolding[] = trustlines.map((t) => ({ kind: 'iou' as const, ...t }))
      const mptEntries: TokenHolding[] = mpts.map((m) => ({ kind: 'mpt' as const, ...m }))
      return [...iouEntries, ...mptEntries]
    })
  }

  // ===== Issuer operations =====

  /**
   * Allow this wallet's IOU to flow through intermediary accounts
   * (`asfDefaultRipple`). Required by anyone who acts as an issuer of an
   * IOU -- without it, holders of the token cannot pay each other through
   * the issuer.
   *
   * MPT-only note: this flag has no MPT counterpart -- MPT transfers are
   * gated by the immutable `allowTransfer` flag set at create time.
   */
  async enableTransfers(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_DEFAULT_RIPPLE, true),
    )
  }

  /**
   * Toggle the `asfRequireAuth` flag for IOUs. When enabled, holders cannot
   * hold a balance of this wallet's IOUs until the wallet calls
   * {@link Wallet.authorize} for them.
   *
   * MPT note: the equivalent flag (`tfMPTRequireAuth`) is **immutable** and
   * is set only at create time -- pass `requireAuthorization: true` to
   * {@link Wallet.createToken} instead.
   *
   * Cannot be enabled on an IOU issuer that already has trustlines.
   */
  async requireAuthorization(
    value: boolean,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_REQUIRE_AUTH, value),
    )
  }

  /**
   * Permanently allow holders of this wallet's IOUs to lock them in
   * an XRPL escrow (`asfAllowTrustLineLocking`, gated on the
   * `TokenEscrow` amendment). Without this flag set on the issuer,
   * `EscrowCreate` carrying an IOU `Amount` is rejected with
   * `tecNO_PERMISSION` even when the trustline and balance are valid.
   *
   * Idempotent on the SDK side: calling it twice just resubmits an
   * `AccountSet` -- the ledger accepts setting an already-set flag.
   *
   * MPT note: the equivalent permission for an MPT is the immutable
   * `allowEscrow` flag set at create time -- pass `allowEscrow: true`
   * to {@link Wallet.createToken} instead.
   */
  async allowTrustLineLocking(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_ALLOW_TRUSTLINE_LOCKING, true),
    )
  }

  /**
   * As issuer, authorise a holder. For an IOU this is a `TrustSet`
   * carrying `tfSetfAuth` (only meaningful when this wallet has
   * {@link Wallet.requireAuthorization} enabled). For an MPT this is an
   * issuer-side `MPTokenAuthorize` carrying the `Holder` field (only
   * meaningful when the issuance has `requireAuthorization`).
   */
  async authorize(
    holder: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        authorizeMPTHolder(client, this.#internal, holder, token),
      )
    }
    return this.#submit(options, (client) =>
      authorizeTrustline(client, this.#internal, holder, token),
    )
  }

  /**
   * As issuer, credit `to` with `amount` of `token`. The recipient must have
   * already accepted the token via {@link Wallet.acceptToken} -- XRPL
   * requires the holder to consent before a balance can land on their
   * account.
   *
   * For IOUs the issuer must equal `token.issuer`; for MPTs it must equal
   * the issuer recorded on the MPTokenIssuance.
   */
  async issue(
    to: string,
    amount: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        issueMPTPayment(client, this.#internal, to, amount, token),
      )
    }
    return this.#submit(options, (client) =>
      issuePayment(client, this.#internal, to, amount, token),
    )
  }

  // ===== MPT-only lifecycle =====

  /**
   * Create a new MPT issuance. Returns the freshly minted {@link MPToken}
   * handle plus the submission hash.
   *
   * Most flags are **immutable** once the issuance is created -- pick
   * `allowTransfer`, `allowEscrow`, `allowTrade`, `requireAuthorization`
   * carefully.
   */
  async createToken(options: CreateTokenOptions & NetworkOptions = {}): Promise<CreateTokenResult> {
    return this.#submit(options, (client) => createMPTIssuance(client, this.#internal, options))
  }

  /** List every MPT issuance this wallet has created. */
  async listIssuedTokens(options: NetworkOptions = {}): Promise<MPTIssuanceInfo[]> {
    return withClient(options, (client) => listMPTIssuances(client, this.address))
  }

  // ===== Escrows =====

  /**
   * Lock funds in an `Escrow` ledger entry. Adds one owner object on
   * this wallet -- the SDK preflights the reserve so a typed
   * `INSUFFICIENT_RESERVE` is surfaced before submission.
   *
   * At least one of `finishAfter` or `condition` must be set:
   * - `finishAfter` only: anyone can `finishEscrow` once the time has
   *   passed (the funds always flow to `destination`).
   * - `condition` only: anyone holding the matching crypto-condition
   *   fulfillment can `finishEscrow` at any time.
   * - both: the finisher must wait for `finishAfter` *and* present the
   *   fulfillment.
   *
   * `cancelAfter` (when set) lets the creator (or anyone) refund the
   * escrow back to this wallet after the cutoff. Must be strictly later
   * than `finishAfter`.
   *
   * The result includes the `Sequence` and `escrowId` you'll need to
   * `finishEscrow` / `cancelEscrow` later. Use {@link generatePreimageCondition}
   * to mint a fresh condition + fulfillment pair when needed.
   */
  async createEscrow(options: CreateEscrowOptions & NetworkOptions): Promise<CreateEscrowResult> {
    return this.#submit(options, (client) => createEscrow(client, this.#internal, options))
  }

  /**
   * Release an escrow's funds to its `Destination`. Anyone can submit
   * (the submitter pays the fee), the funds always go to the recipient
   * recorded on the escrow.
   *
   * The SDK preflights:
   * - The escrow exists (else `ESCROW_NOT_FOUND`).
   * - `FinishAfter` is in the past (else `ESCROW_NOT_READY`).
   * - When the escrow has a `Condition`, both `condition` and
   *   `fulfillment` are provided and the condition matches.
   */
  async finishEscrow(options: FinishEscrowOptions & NetworkOptions): Promise<{ hash: string }> {
    return this.#submit(options, (client) => finishEscrow(client, this.#internal, options))
  }

  /**
   * Refund an escrow to its creator (`Owner`). Only valid after the
   * escrow's `CancelAfter` cutoff -- the SDK surfaces an early typed
   * `ESCROW_NOT_READY` instead of letting a `tecNO_PERMISSION` bubble
   * up. Anyone can submit; the funds always flow back to `Owner`.
   *
   * Throws `ESCROW_NOT_READY` immediately when the escrow was created
   * without `CancelAfter` -- such escrows can only be finished, never
   * cancelled.
   */
  async cancelEscrow(reference: EscrowReference & NetworkOptions): Promise<{ hash: string }> {
    return this.#submit(reference, (client) => cancelEscrow(client, this.#internal, reference))
  }

  /**
   * Read one escrow on this wallet's behalf. Returns null when no such
   * escrow exists (already finished, cancelled, or never created).
   */
  async getEscrow(
    reference: EscrowReference,
    options: NetworkOptions = {},
  ): Promise<EscrowInfo | null> {
    return withClient(options, (client) => getEscrow(client, reference))
  }

  /**
   * List every escrow this wallet currently owns. Returns [] when the
   * account is unfunded or has no escrow objects.
   */
  async listEscrows(options: NetworkOptions = {}): Promise<EscrowInfo[]> {
    return withClient(options, (client) => listEscrows(client, this.address))
  }

  // ===== Account state =====

  /**
   * Read the wallet's current XRP balance, in drops. Returns `'0'` when the
   * account has not been activated on the ledger yet (i.e. `actNotFound`).
   *
   * Use {@link Methods.fromDrops} to format as XRP if needed.
   */
  async getXrpBalance(options: NetworkOptions = {}): Promise<string> {
    return withClient(options, async (client) => {
      try {
        const r = await client.request({ command: 'account_info', account: this.address })
        return (r.result.account_data.Balance as string) ?? '0'
      } catch (err: any) {
        if (err?.data?.error === 'actNotFound') return '0'
        throw err
      }
    })
  }
}

/**
 * Resolve a wallet from either a Wallet instance or a seed string.
 *
 * Used by SDK entry points that historically accepted only a seed. New code
 * should prefer passing a {@link Wallet} directly.
 *
 * @internal
 */
export function resolveWallet(input: { wallet?: Wallet; seed?: string }): Wallet {
  if (input.wallet) return input.wallet
  if (input.seed) return Wallet.fromSeed(input.seed)
  throw new Error('[xrpl-mpp-sdk] A wallet or seed is required.')
}

/**
 * Open a short-lived xrpl.js Client, run `fn`, and disconnect on exit. Shared
 * by every Wallet method that hits the ledger so connection lifecycle stays
 * in one place.
 */
async function withClient<T>(
  options: NetworkOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const network = options.network ?? 'testnet'
  const rpcUrl = options.rpcUrl ?? XRPL_RPC_URLS[network]
  // Wallet operations sign and submit transactions, so the transport carries
  // signed blobs and returns results the caller acts on.
  assertSecureRpcUrl({ rpcUrl, allowInsecureTransport: false, context: 'wallet operation' })
  const client = new Client(rpcUrl)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.disconnect()
  }
}
