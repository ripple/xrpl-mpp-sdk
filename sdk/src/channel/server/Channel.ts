import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, verifyPaymentChannelClaim } from 'xrpl'
import { MPP_SOURCE_TAG, type NetworkId, XRPL_RPC_URLS } from '../../constants.js'
import {
  channelClosed,
  channelClosing,
  channelDestinationMismatch,
  channelExhausted,
  channelNotFound,
  channelSettleDelayTooShort,
  invalidSignature,
  replayDetected,
  verificationFailed,
} from '../../errors.js'
import type { ChannelServerConfig } from '../../types.js'
import { dropsToXrpString } from '../../utils/amount.js'
import { classicAddressFromDID, classicAddressFromPublicKey } from '../../utils/did.js'
import { type StoreKeys, storeKeys } from '../../utils/keys.js'
import { assertTxExpiresWithinChallenge, readCurrentLedgerIndex } from '../../utils/ledger-time.js'
import { assertRouteTermsMatch } from '../../utils/route.js'
import {
  PayChannelEntry,
  parseOrNull,
  StoredChannelMeta,
  StoredHighWater,
  StoredRedeemed,
} from '../../utils/schemas.js'
import {
  advanceHighWater,
  assertAtomicStore,
  assertStoreDurability,
  claimKey,
  type ReplayStore,
  replayRetentionFor,
  type StoreDurability,
} from '../../utils/store.js'
import { assertSecureRpcUrl } from '../../utils/transport.js'
import { cappedMetadataTtlMs } from '../../utils/validation.js'
import { resolveWallet, type Wallet } from '../../utils/wallet.js'
import { warnOnce } from '../../utils/warn.js'
import { channel as ChannelMethod } from '../Methods.js'

/**
 * Minimum `SettleDelay`, in seconds, a channel must carry.
 *
 * After a funder initiates close, `SettleDelay` is the only window in which the
 * recipient can still redeem. It has to comfortably exceed how long this server
 * takes to notice and submit a claim, which is bounded by the auto-close sweep
 * interval plus a ledger close. One hour is conventional and leaves ample room.
 */
const DEFAULT_MIN_SETTLE_DELAY_SECONDS = 3600

/**
 * Backstop size cap on a channel credential. The charge method had one and this
 * path had none, which was an asymmetry rather than a decision.
 *
 * A voucher is tiny: a 64-character channelId, a drops amount and a signature.
 * Tighter than charge's 64 KB because there is no transaction blob here.
 *
 * Only a backstop: see `assertCredentialHeaderSize` for why the meaningful limit
 * has to sit in front of mppx.
 */
const DEFAULT_MAX_CREDENTIAL_SIZE = 8 * 1024

/**
 * Refuse vouchers once a channel is within this long of closing.
 *
 * Redemption needs a `PaymentChannelClaim` submitted and validated, so a claim
 * accepted at the last moment may never be collectable.
 */
const DEFAULT_SETTLEMENT_MARGIN_MS = 60_000

/**
 * Creates an XRPL channel method for use on the **server**.
 *
 * Verifies off-chain PayChannel claims using verifyPaymentChannelClaim
 * from xrpl.js, tracks cumulative amounts via Store, and supports
 * closing channels on-chain.
 *
 * @example
 * ```ts
 * import { Mppx, Store } from 'mppx/server'
 * import { xrpl } from 'xrpl-mpp-sdk/channel/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.channel({
 *       publicKey: 'ED...',
 *     }),
 *   ],
 * })
 * ```
 */
export function channel(parameters: channel.Parameters) {
  const {
    publicKey,
    recipient,
    network = 'testnet',
    rpcUrl: customRpcUrl,
    store,
    requireStore = true,
    storeDurability,
    allowInsecureTransport = false,
    verifyChannelOnChain = true,
    allowUnverifiedChannels = false,
    minSettleDelay = DEFAULT_MIN_SETTLE_DELAY_SECONDS,
    settlementMarginMs = DEFAULT_SETTLEMENT_MARGIN_MS,
    maxCredentialSize = DEFAULT_MAX_CREDENTIAL_SIZE,
    channelMetadataTtlMs: channelMetadataTtlMsInput = 60_000,
    channelLookup,
    onDisputeDetected,
    onVoucherAccepted,
    wallet: walletInput,
    seed: walletSeed,
    autoClose,
  } = parameters

  if (!store && requireStore) {
    throw new Error(
      '[xrpl-mpp-sdk] store is required for replay protection and cumulative tracking. ' +
        'Pass requireStore: false to explicitly disable.',
    )
  }

  // The cumulative high-water mark is the session flow's double-spend control.
  // It is only sound if the store can compare-and-set and every replica sees
  // the same state, so both are enforced at construction.
  if (store) {
    assertAtomicStore(store, 'channel cumulative tracking')
    assertStoreDurability({ durability: storeDurability, network, context: 'channel' })
  }
  const replayStore: ReplayStore | undefined = store

  // Turning off on-chain verification removes every party, expiry, funding and
  // settle-delay check at once, leaving only the claim signature -- which proves
  // the funder signed something, not that the channel exists, pays this server,
  // or holds the money. Gated like requireStore rather than silently honoured.
  if (!verifyChannelOnChain && !allowUnverifiedChannels) {
    throw new Error(
      '[xrpl-mpp-sdk] verifyChannelOnChain: false disables the channel destination, funder, ' +
        'expiry, settle-delay and funding checks, so a cryptographically valid claim for any ' +
        'channelId -- including a fabricated one -- would be accepted. Pass ' +
        'allowUnverifiedChannels: true to acknowledge that explicitly.',
    )
  }
  if (!verifyChannelOnChain) {
    warnOnce(
      'channel-onchain-verification-disabled',
      '[xrpl-mpp-sdk] channel on-chain verification is disabled. Claims are accepted on signature ' +
        'alone, with no proof the channel exists, pays this recipient, or is funded.',
    )
  }

  // The metadata cache may hold `expiration`, and a funder can set or shorten
  // it at any time. Serving a voucher from a cache as old as the settlement
  // margin therefore spends the whole margin on staleness: the channel may have
  // entered its closing window up to one TTL ago, leaving no real time to
  // redeem. The margin only means something if it exceeds how stale the data
  // behind it can be, so the TTL is capped at half of it.
  //
  // Capped rather than rejected: an operator who tuned the TTL for latency
  // should not fail to boot over it, and the safe value is computable.
  const channelMetadataTtlMs = cappedMetadataTtlMs(channelMetadataTtlMsInput, settlementMarginMs)
  if (channelMetadataTtlMs < channelMetadataTtlMsInput) {
    warnOnce(
      `channel-meta-ttl:${network}`,
      `[xrpl-mpp-sdk] channelMetadataTtlMs ${channelMetadataTtlMsInput}ms exceeds half of ` +
        `settlementMarginMs ${settlementMarginMs}ms, so cached channel state could consume the ` +
        `whole margin. Capped to ${channelMetadataTtlMs}ms. Raise settlementMarginMs to keep a ` +
        'longer cache.',
    )
  }

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  assertSecureRpcUrl({ rpcUrl, allowInsecureTransport, context: 'channel' })
  // Namespaced by network: a channelId is identical across networks for a
  // seed-identical funder, so an un-namespaced store shared between them lets
  // one network's activity move another's high-water mark.
  const keys = storeKeys(network)

  // Resolve auto-close: defaults to ON when a recipient wallet was provided.
  // The MPP spec (https://mpp.dev/payment-methods/tempo/session,
  // /stellar/session) lets either party close the session, and so does the
  // ledger: a `PaymentChannelClaim` with `tfClose` from the destination
  // settles and deletes the channel in one transaction. The store is also
  // marked `finalized`, which stops further vouchers without a ledger read.
  const recipientWallet =
    walletInput || walletSeed ? resolveWallet({ wallet: walletInput, seed: walletSeed }) : null
  const autoCloseConfig = resolveAutoCloseConfig(autoClose, recipientWallet !== null)

  // The channel's on-ledger Destination must be this address, otherwise its
  // claims are unredeemable here. Prefer the explicit recipient, fall back to
  // the wallet we would close with, and warn when neither is available.
  const expectedRecipient = recipient ?? recipientWallet?.address
  if (recipient && recipientWallet && recipient !== recipientWallet.address) {
    throw new Error(
      `[xrpl-mpp-sdk] recipient ${recipient} does not match the configured wallet ` +
        `(${recipientWallet.address}). The channel destination and the wallet used to redeem ` +
        'claims must be the same account.',
    )
  }
  if (!expectedRecipient) {
    warnOnce(
      'channel-recipient-unset',
      '[xrpl-mpp-sdk] channel() has no `recipient` (and no `wallet`/`seed` to derive one from), ' +
        'so the on-chain channel Destination cannot be checked. A funder can open a channel to ' +
        'their own address and receive service against claims this server can never redeem. ' +
        'Pass `recipient` with the address the channel must pay.',
    )
  }

  if (autoCloseConfig && !recipientWallet) {
    throw new Error(
      '[xrpl-mpp-sdk] autoClose requires a recipient `wallet` (or `seed`) so the SDK ' +
        'can sign the on-chain `PaymentChannelClaim` that finalizes the channel.',
    )
  }
  if (autoCloseConfig && !store) {
    throw new Error('[xrpl-mpp-sdk] autoClose requires a `store` to read the latest voucher from.')
  }

  // Channel IDs we have personally opened and not yet finalized. Used by the
  // auto-close sweeper; populated in doVerifyOpen success path. In-process
  // only -- distributed deployments should run their own sweeper backed by
  // a shared registry. Map value is the funder publicKey, needed to build
  // the `PaymentChannelClaim` transaction.
  const activeChannels = new Map<string, string>()

  let stopSweeper: (() => void) | null = null
  if (autoCloseConfig && recipientWallet && store) {
    stopSweeper = startAutoCloseSweeper({
      wallet: recipientWallet,
      store,
      network,
      rpcUrl,
      activeChannels,
      config: autoCloseConfig,
    })
  }

  // Same-process fast path only. Correctness across processes comes from the
  // atomic compare-and-set in `advanceHighWater`; this lock just avoids
  // redundant ledger lookups when several vouchers for one channel arrive
  // together. Keyed by channelId so unrelated channels -- and high-rate
  // streaming across many channels -- never queue behind each other.
  const channelLocks = new Map<string, Promise<unknown>>()

  function withChannelLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = channelLocks.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    // Release the slot once this task settles, but only if no later verify has
    // already chained onto it, otherwise the map grows one entry per channel
    // for the lifetime of the process.
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    channelLocks.set(key, settled)
    void settled.then(() => {
      if (channelLocks.get(key) === settled) channelLocks.delete(key)
    })
    return run
  }

  const method = Method.toServer(ChannelMethod, {
    // Wire intent is the canonical `session`; keep `channel` as a routing alias
    // so credentials issued against the pre-`session` wire intent still verify.
    alias: 'channel',
    async request({ request }) {
      // Surface the current cumulative so clients know where to resume.
      let cumulativeAmount = '0'
      if (store && request.channelId) {
        const state = parseOrNull(StoredHighWater, await store.get(keys.channel(request.channelId)))
        if (state) cumulativeAmount = state.cumulative
      }
      return {
        ...request,
        methodDetails: {
          ...request.methodDetails,
          reference: crypto.randomUUID(),
          network,
          cumulativeAmount,
        },
      }
    },
    async verify({ credential, request }) {
      const payload = credential.payload
      // In-process lock key only, never a store key: the open action has no
      // channelId yet, so those verifies share one slot.
      const lockKey = 'channelId' in payload ? payload.channelId : 'pending-open'
      return await withChannelLock(lockKey, () => doVerify(credential, request))
    },
  })

  // Attach a `dispose()` so callers can stop the background sweeper
  // explicitly (e.g. on graceful shutdown). The setInterval is unref'd
  // already, so this is only required for hot-reload / test cleanup.
  ;(method as channel.MethodWithDispose).dispose = () => {
    stopSweeper?.()
  }
  return method as channel.MethodWithDispose

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
    const payload = credential.payload
    const channelId = payload.channelId

    // Confirm the challenge asks for what this route charges, before any of its
    // terms are used.
    assertRouteTermsMatch(challenge?.request, routeRequest)

    // Bind the credential to its DID-encoded sender. The address derived from
    // the configured channel publicKey must match the credential source --
    // otherwise an attacker can replay claims under their own DID.
    const expectedSenderAddress = classicAddressFromPublicKey(publicKey)
    const credentialSenderAddress = classicAddressFromDID(credential.source)
    if (credentialSenderAddress !== expectedSenderAddress) {
      throw verificationFailed(
        'SOURCE_MISMATCH',
        `Credential source ${credentialSenderAddress} does not match channel funder ${expectedSenderAddress}`,
      )
    }

    if (store && channelId) {
      const finalized = await store.get(keys.channelFinalized(channelId))
      if (finalized) {
        throw channelClosed(channelId)
      }
    }

    // Freshness comes from `expires`, which mppx covers with the challenge HMAC
    // and rejects fail-closed before this method runs. Repeated here as defence
    // in depth for callers that invoke `verify` directly. An mppx challenge has
    // no issuance timestamp, so `expires` is the only authenticated anchor.
    const challengeExpires = (challenge as { expires?: string }).expires
    if (!challengeExpires) {
      // Not fatal here, unlike the charge path: the cumulative high-water mark
      // is an independent single-use control, and retention falls back to
      // forever below so no marker can lapse. Still worth surfacing, since the
      // LastLedgerSequence cap on the open action does depend on `expires`.
      warnOnce(
        'channel-challenge-expires-missing',
        '[xrpl-mpp-sdk] a channel credential arrived with no challenge `expires`. Replay markers ' +
          'will be retained indefinitely and the open-action LastLedgerSequence cap cannot be ' +
          'applied. mppx sets `expires` by default.',
      )
    }
    if (challengeExpires) {
      const expiresMs = Date.parse(challengeExpires)
      if (Number.isNaN(expiresMs)) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Challenge carries a malformed expires timestamp: ${challengeExpires}`,
        )
      }
      if (expiresMs < Date.now()) {
        throw verificationFailed('SUBMISSION_FAILED', `Challenge expired at ${challengeExpires}`)
      }
    }

    // Bound the retention of this voucher's challenge marker. Without it every
    // accepted voucher left a permanent entry, which on the pay-per-token
    // streaming path this method exists to serve means one immortal key per
    // token.
    //
    // `undefined` means retain forever, and that is deliberate: substituting a
    // finite guess when `expires` is unusable would let the single-use marker
    // lapse while the credential itself never expires. On the open path that
    // marker is the only gate before a submission is spent.
    const challengeRetentionMs = replayRetentionFor({
      expiresIso: challengeExpires,
      pollTimeout: 0,
    })

    const action = payload.action ?? 'voucher'

    if (action === 'open') {
      return await doVerifyOpen(credential)
    }

    const newCumulative = BigInt(payload.amount)
    const signature = payload.signature
    const requestedAmount = BigInt(challenge.request?.amount ?? '0')

    // Verify the signature first: it is local and free, whereas the ledger
    // lookup below opens a WebSocket. `credential.source` is unauthenticated and
    // the funder address is public, so anyone can send a voucher with a garbage
    // signature for a real channelId; checking the ledger first turned each such
    // request into a round trip against this server and its rippled endpoint.
    //
    // Verifying against the configured key is equivalent to verifying against
    // ledger truth: `assertChannelParties` below refuses any channel whose
    // on-ledger PublicKey differs from it, so the two are necessarily equal for
    // a voucher that gets accepted.
    const claimXrp = dropsToXrpString(payload.amount)
    let isValid: boolean
    try {
      isValid = verifyPaymentChannelClaim(channelId, claimXrp, signature, publicKey)
    } catch {
      // xrpl.js throws on malformed or cross-curve signatures instead of
      // returning false.
      isValid = false
    }

    if (!isValid) {
      throw invalidSignature('Claim signature verification failed')
    }

    let verifiedMeta: CachedChannelMeta | undefined
    if (verifyChannelOnChain) {
      const lookup = channelLookup ?? defaultChannelLookup(rpcUrl)
      const channelMeta = await loadChannelMetadata({
        channelId,
        keys,
        store,
        ttlMs: channelMetadataTtlMs,
        lookup,
        forceRefresh: false,
      })
      assertChannelParties({
        channelId,
        meta: channelMeta,
        recipient: expectedRecipient,
        configuredPublicKey: publicKey,
      })
      assertChannelHealthy({
        channelId,
        keys,
        meta: channelMeta,
        store,
        onDisputeDetected,
        settlementMarginMs,
      })
      assertSettleDelay({ channelId, meta: channelMeta, minSettleDelay })
      verifiedMeta = channelMeta
      let channelBalance = BigInt(channelMeta.amount)
      // Cumulative exceeds the cached balance: re-fetch once -- the funder may
      // have topped up via PaymentChannelFund since we last looked.
      if (newCumulative > channelBalance) {
        const refreshed = await loadChannelMetadata({
          channelId,
          keys,
          store,
          ttlMs: channelMetadataTtlMs,
          lookup,
          forceRefresh: true,
        })
        assertChannelParties({
          channelId,
          meta: refreshed,
          recipient: expectedRecipient,
          configuredPublicKey: publicKey,
        })
        assertChannelHealthy({
          channelId,
          keys,
          meta: refreshed,
          store,
          onDisputeDetected,
          settlementMarginMs,
        })
        verifiedMeta = refreshed
        channelBalance = BigInt(refreshed.amount)
        if (newCumulative > channelBalance) {
          throw channelExhausted(channelId, newCumulative, channelBalance)
        }
      }
    }

    // Claim the challenge only once the voucher has proven itself: correct
    // parties, funded channel, valid signature. Claiming earlier let any
    // malformed or forged voucher consume a store entry.
    if (replayStore) {
      const claimed = await claimKey(
        replayStore,
        keys.challenge(challenge.id),
        { usedAt: new Date().toISOString() },
        challengeRetentionMs,
      )
      if (!claimed) throw replayDetected(challenge.id)
    }

    // Compare against the stored high-water mark and write the new one in a
    // single atomic operation. Two concurrent vouchers -- in this process or in
    // another replica -- cannot both be credited above the same prior mark:
    // exactly one gets `advanced`, the other is rejected. Every ledger lookup
    // above already happened, because the compare-and-set callback must stay
    // synchronous and side-effect free.
    if (replayStore) {
      const outcome = await advanceHighWater(replayStore, keys.channel(channelId), {
        cumulative: newCumulative,
        requested: requestedAmount,
        signature,
        timestamp: Date.now(),
      })

      switch (outcome.status) {
        case 'replay':
          throw replayDetected(`${channelId}:${payload.amount}`)
        case 'regressed':
          throw verificationFailed(
            'AMOUNT_MISMATCH',
            `New cumulative ${newCumulative} is less than previous ${outcome.previous}`,
          )
        case 'short':
          throw verificationFailed(
            'AMOUNT_MISMATCH',
            `Cumulative ${newCumulative} does not cover requested amount ${requestedAmount} (expected >= ${outcome.previous + requestedAmount})`,
          )
      }
    }

    // Also register the channel for the auto-close sweeper here, not only
    // in doVerifyOpen. Some integrations (and our own integration tests)
    // open the channel out-of-band via `openChannel()` and only ever go
    // through the voucher path -- they never trigger doVerifyOpen. Without
    // this branch, the sweeper would never see those channels and the
    // server-side close would silently no-op.
    if (!activeChannels.has(channelId)) {
      activeChannels.set(channelId, publicKey)
    }

    // Report unsettled exposure to the operator. A voucher is a claim rather
    // than settled funds, so anyone metering high-value service needs to know
    // how much of the channel is still redeemable and when it closes, without
    // querying the ledger themselves.
    //
    // Delivered by callback rather than on the receipt: mppx's Receipt shape is
    // fixed and carries no metadata field.
    if (onVoucherAccepted && verifiedMeta) {
      const closesAt = verifiedMeta.expiration ?? verifiedMeta.cancelAfter
      onVoucherAccepted({
        channelId,
        cumulative: payload.amount,
        fundedDrops: verifiedMeta.amount,
        remainingDrops: (BigInt(verifiedMeta.amount) - newCumulative).toString(),
        ...(closesAt != null ? { closesAt: new Date(rippleTimeToMs(closesAt)).toISOString() } : {}),
      })
    }

    return Receipt.from({
      method: 'xrpl',
      reference: `${channelId}:${payload.amount}`,
      ...(challenge.id ? { externalId: challenge.id } : {}),
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function doVerifyOpen(credential: any): Promise<Receipt.Receipt> {
    const { challenge, payload } = credential
    const blob = payload.transaction as string

    let decoded: any
    try {
      decoded = decode(blob)
    } catch {
      throw verificationFailed('SUBMISSION_FAILED', 'Could not decode open transaction blob')
    }

    if (decoded.TransactionType !== 'PaymentChannelCreate') {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Expected PaymentChannelCreate, got ${decoded.TransactionType}`,
      )
    }

    const challengeRecipient = challenge.request?.recipient
    if (challengeRecipient && decoded.Destination !== challengeRecipient) {
      throw verificationFailed(
        'RECIPIENT_MISMATCH',
        `Channel destination ${decoded.Destination} does not match expected ${challengeRecipient}`,
      )
    }

    // Also check against the server's configured recipient, not only the
    // challenge. A channel opened towards any other account produces claims
    // this server can never redeem.
    if (expectedRecipient && decoded.Destination !== expectedRecipient) {
      throw channelDestinationMismatch('(pending)', expectedRecipient, decoded.Destination)
    }

    if (decoded.PublicKey?.toUpperCase() !== publicKey.toUpperCase()) {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Channel PublicKey ${decoded.PublicKey} does not match expected ${publicKey}`,
      )
    }

    // Re-assert the funder/source binding inside the open path. doVerify()
    // already checked source vs publicKey-derived address; this also covers
    // the funder (decoded.Account) so a refactor that splits the paths
    // doesn't drop the invariant.
    const credentialSenderAddress = classicAddressFromDID(credential.source)
    if (decoded.Account !== credentialSenderAddress) {
      throw verificationFailed(
        'SOURCE_MISMATCH',
        `Channel Account ${decoded.Account} does not match credential source ${credentialSenderAddress}`,
      )
    }

    // Claim the challenge now that the open blob has been decoded and its
    // destination, public key and funder all check out, but before we spend a
    // submission on it.
    if (replayStore) {
      const openExpires = (challenge as { expires?: string }).expires
      const claimed = await claimKey(
        replayStore,
        keys.challenge(challenge.id),
        { usedAt: new Date().toISOString() },
        replayRetentionFor({ expiresIso: openExpires, pollTimeout: 0 }),
      )
      if (!claimed) throw replayDetected(challenge.id)
    }

    const client = new Client(rpcUrl)
    await client.connect()

    try {
      // Reject open blobs whose LastLedgerSequence would let them land past
      // challenge.expires *before* spending a submit. Mirrors the same gate
      // applied to charge in server/Charge.ts -- without it, an attacker who
      // intercepts a signed PaymentChannelCreate can replay it on-ledger
      // after the challenge has logically expired.
      const challengeExpires = (challenge as { expires?: string }).expires
      const txLLS = (decoded as { LastLedgerSequence?: number }).LastLedgerSequence
      if (challengeExpires && typeof txLLS === 'number') {
        const currentLedgerIndex = await readCurrentLedgerIndex(client)
        try {
          assertTxExpiresWithinChallenge({
            txLastLedgerSequence: txLLS,
            currentLedgerIndex,
            expiresIso: challengeExpires,
          })
        } catch (err: any) {
          const reason =
            typeof err?.message === 'string'
              ? err.message
              : 'LastLedgerSequence vs challenge expiry check failed'
          // Strip the helper's `[CODE] ` prefix so verificationFailed's own
          // prefix is not duplicated.
          const detail = reason.replace(/^\[[^\]]+\]\s*/, '')
          throw verificationFailed('SUBMISSION_FAILED', detail)
        }
      }

      const submitResult = await client.submit(blob)
      const engineResult = submitResult.result.engine_result

      if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `PaymentChannelCreate submission failed: ${engineResult}`,
        )
      }

      const txHash = submitResult.result.tx_json?.hash
      if (!txHash) {
        throw verificationFailed('SUBMISSION_FAILED', 'No tx hash returned from submit')
      }

      let meta: any
      for (let i = 0; i < 60; i++) {
        try {
          const txResponse = await client.request({ command: 'tx', transaction: txHash })
          meta = (txResponse.result as any).meta ?? (txResponse.result as any).metaData
          if (meta?.TransactionResult === 'tesSUCCESS') break
          if (meta?.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') {
            throw verificationFailed(
              'SUBMISSION_FAILED',
              `PaymentChannelCreate failed: ${meta.TransactionResult}`,
            )
          }
        } catch (err: any) {
          if (err?.data?.error !== 'txnNotFound') throw err
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      if (meta?.TransactionResult !== 'tesSUCCESS') {
        throw verificationFailed('SUBMISSION_FAILED', 'PaymentChannelCreate not confirmed in time')
      }

      const channelId = extractChannelIdFromMeta(meta)

      // Validate the initial claim against the real channelId.
      //
      // The client cannot know the channelId at sign time, so the open-action
      // signature is typically computed against an all-zero placeholder. Two
      // legitimate cases:
      //   (a) initialAmount === 0: client is opening without an initial
      //       commitment. The signature carries no value claim, so the
      //       placeholder vs real-channelId mismatch is fine. Store
      //       cumulative=0 and let the first real voucher set the floor.
      //   (b) initialAmount > 0 AND the signature verifies against the real
      //       channelId: the client knew the channelId in advance (rare but
      //       valid). Honor it.
      //
      // Anything else (initialAmount > 0 and sig does NOT verify) is rejected.
      // Silently zeroing the cumulative would discard the funder's stated
      // initial commitment and hide client bugs (wrong wallet, off-by-one
      // channelId, wrong amount in the sig vs the payload).
      const initialAmount = payload.amount
      const initialAmountBig = BigInt(initialAmount)

      if (initialAmountBig > 0n) {
        const initialXrp = dropsToXrpString(initialAmount)
        let sigValid: boolean
        try {
          sigValid = verifyPaymentChannelClaim(channelId, initialXrp, payload.signature, publicKey)
        } catch {
          sigValid = false
        }
        if (!sigValid) {
          throw invalidSignature(
            `Initial claim signature does not verify against the real channelId ${channelId}. ` +
              'Set request.amount to "0" on the open action to commit nothing, or sign ' +
              'against the real channelId after it is known.',
          )
        }
      }

      // Seed the high-water mark with put-if-absent rather than an
      // unconditional write. A fresh PaymentChannelCreate always yields a new
      // channelId, so a collision is not reachable today, but an unconditional
      // write on this path would reset an existing mark to zero.
      if (replayStore) {
        await claimKey(replayStore, keys.channel(channelId), {
          cumulative: initialAmountBig > 0n ? initialAmount : '0',
          signature: initialAmountBig > 0n ? payload.signature : '',
          timestamp: Date.now(),
        })
      }

      // Register the channel with the auto-close sweeper. The funder publicKey
      // is required to build the `PaymentChannelClaim` tx at close time.
      activeChannels.set(channelId, publicKey)

      return Receipt.from({
        method: 'xrpl',
        reference: `open:${channelId}:${txHash}`,
        ...(challenge.id ? { externalId: challenge.id } : {}),
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    } finally {
      await client.disconnect()
    }
  }
}

/** Cached PayChannel metadata. */
type CachedChannelMeta = {
  /** Funder account on the ledger. */
  account: string
  /** Who the channel actually pays. Must equal the configured recipient. */
  destination: string
  /** On-ledger funder key. `null` when a custom lookup omitted the field. */
  publicKey: string | null
  amount: string
  /** Drops already claimed by the destination. */
  balance: string
  settleDelay: number | null
  expiration: number | null
  cancelAfter: number | null
  cachedAt: number
}

/** Looks up a PayChannel object on-chain by channel ID. Returns null if missing. */
export type ChannelLookup = (channelId: string) => Promise<PayChannelLedgerEntry | null>

/** Subset of PayChannel ledger entry fields the SDK consumes. */
export type PayChannelLedgerEntry = {
  Account: string
  Destination: string
  Amount: string
  Balance?: string
  /** Funder key claims must verify against. Ledger truth, not configuration. */
  PublicKey?: string
  SettleDelay?: number
  Expiration?: number | null
  CancelAfter?: number | null
}

/** Default channel lookup uses xrpl.js Client + ledger_entry. */
function defaultChannelLookup(rpcUrl: string): ChannelLookup {
  return async (channelId) => {
    const client = new Client(rpcUrl)
    await client.connect()
    try {
      return (await lookupChannel(client, channelId)) as PayChannelLedgerEntry | null
    } finally {
      await client.disconnect()
    }
  }
}

/**
 * Fetch channel metadata, using the store as a TTL cache. The cache is keyed
 * by channelId and refreshes when stale or when `forceRefresh` is set.
 *
 * Without a store, every call hits the ledger.
 */
async function loadChannelMetadata(params: {
  channelId: string
  keys: StoreKeys
  store: ReplayStore | undefined
  ttlMs: number
  lookup: ChannelLookup
  forceRefresh: boolean
}): Promise<CachedChannelMeta> {
  const { channelId, keys, store, ttlMs, lookup, forceRefresh } = params
  const cacheKey = keys.channelMeta(channelId)

  if (!forceRefresh && store && ttlMs > 0) {
    // A cached value that no longer parses (written by an older version, or by
    // a foreign network sharing the store) is treated as a cache miss.
    const cached = parseOrNull<CachedChannelMeta>(StoredChannelMeta, await store.get(cacheKey))
    if (cached && Date.now() - cached.cachedAt < effectiveTtl(cached, ttlMs)) {
      return cached
    }
  }

  const channelObj = await lookup(channelId)
  if (!channelObj) {
    // Deliberately no tombstone. Writing one here let anyone create a store
    // entry for any 64-hex string they cared to send, which is unauthenticated
    // growth. A missing channel needs no memo: the next lookup returns null
    // again, at the cost of one RPC rather than unbounded storage.
    throw channelNotFound(channelId)
  }
  const meta: CachedChannelMeta = {
    account: channelObj.Account,
    destination: channelObj.Destination,
    publicKey: channelObj.PublicKey ?? null,
    amount: channelObj.Amount,
    balance: channelObj.Balance ?? '0',
    settleDelay: channelObj.SettleDelay ?? null,
    expiration: channelObj.Expiration ?? null,
    cancelAfter: channelObj.CancelAfter ?? null,
    cachedAt: Date.now(),
  }
  if (store) {
    await store.put(cacheKey, meta)
  }
  return meta
}

/**
 * Cap the cache lifetime by how long the channel has left.
 *
 * Expiry and closing state were read from a cache with a flat TTL, and the
 * forced refresh only triggered on the balance condition, so a channel that
 * began closing could be honoured for the rest of the TTL. Shrinking the window
 * as the channel approaches its deadline means the last look before a close is
 * always fresh, without paying for a lookup on every voucher.
 */
function effectiveTtl(meta: CachedChannelMeta, ttlMs: number): number {
  const deadlines = [meta.expiration, meta.cancelAfter]
    .filter((t): t is number => t !== null)
    .map((t) => rippleTimeToMs(t) - Date.now())
    .filter((remaining) => remaining > 0)

  if (deadlines.length === 0) return ttlMs
  // Never cache past a third of the remaining window, so at least a couple of
  // refreshes land before the deadline.
  return Math.max(0, Math.min(ttlMs, Math.floor(Math.min(...deadlines) / 3)))
}

/**
 * Assert the channel on the ledger actually pays this server.
 *
 * Without this, a funder can open a channel whose `Destination` is their own
 * address, fund it, and sign perfectly valid cumulative claims: the signature
 * verifies, the channel exists, the balance covers the cumulative, and
 * monotonicity holds. Service is granted, yet the claims are unredeemable and
 * the funder recovers everything once `SettleDelay` elapses.
 *
 * The funder identity is taken from the ledger too. The configured `publicKey`
 * is treated as an optional allowlist rather than the source of truth, so
 * verification is against ledger state and multi-funder deployments work.
 */
function assertChannelParties(params: {
  channelId: string
  meta: CachedChannelMeta
  recipient: string | undefined
  configuredPublicKey: string
}): void {
  const { channelId, meta, recipient, configuredPublicKey } = params

  if (recipient !== undefined && meta.destination !== recipient) {
    throw channelDestinationMismatch(channelId, recipient, meta.destination)
  }

  if (
    meta.publicKey !== null &&
    meta.publicKey.toUpperCase() !== configuredPublicKey.toUpperCase()
  ) {
    throw verificationFailed(
      'SOURCE_MISMATCH',
      `Channel ${channelId} is funded by public key ${meta.publicKey}, which is not the ` +
        'configured channel publicKey. Claims are verified against the on-ledger key.',
    )
  }

  const funderFromKey = classicAddressFromPublicKey(effectivePublicKey(meta, configuredPublicKey))
  if (meta.account !== funderFromKey) {
    throw verificationFailed(
      'SOURCE_MISMATCH',
      `Channel ${channelId} account ${meta.account} does not match the address derived from ` +
        `its channel public key (${funderFromKey}).`,
    )
  }
}

/**
 * The key claims must verify against: the on-ledger `PublicKey` when the lookup
 * surfaced it, otherwise the configured one. Custom `channelLookup`
 * implementations may omit the field, so the configured key remains the
 * fallback rather than a hard requirement.
 */
function effectivePublicKey(meta: CachedChannelMeta, configuredPublicKey: string): string {
  return meta.publicKey ?? configuredPublicKey
}

/** Reject claims on expired channels and emit a dispute callback for pending close. */
function assertChannelHealthy(params: {
  channelId: string
  keys: StoreKeys
  meta: CachedChannelMeta
  store: ReplayStore | undefined
  onDisputeDetected: ((state: ChannelDisputeState) => void) | undefined
  /**
   * Refuse a voucher once the channel is within this many ms of closing. A
   * claim accepted inside that window may not be redeemable, since redemption
   * needs a submitted and validated PaymentChannelClaim.
   */
  settlementMarginMs: number
}): void {
  const { channelId, keys, meta, store, onDisputeDetected, settlementMarginMs } = params
  const now = Date.now()

  const finalize = (reason: string) => {
    if (store) {
      // Fire-and-forget; we re-check on the next call anyway.
      void store.put(keys.channelFinalized(channelId), { reason, timestamp: now })
    }
  }

  if (meta.expiration !== null) {
    const expirationMs = rippleTimeToMs(meta.expiration)
    if (now > expirationMs) {
      finalize('expired')
      throw channelClosed(channelId)
    }
    // Closing, and too close to closing to settle against. Accepting a voucher
    // inside this margin would leave no time to submit a claim before the
    // channel goes, so the value would be earned and unredeemable.
    if (expirationMs - now <= settlementMarginMs) {
      finalize('closing')
      throw channelClosing(channelId, new Date(expirationMs).toISOString())
    }
  }

  if (meta.cancelAfter !== null) {
    const cancelMs = rippleTimeToMs(meta.cancelAfter)
    // CancelAfter is enforced on the same margin as Expiration, not merely
    // reported: once it passes, anyone can delete the channel and unredeemed
    // value returns to the funder.
    if (now > cancelMs) {
      finalize('cancelled')
      throw channelClosed(channelId)
    }
    if (cancelMs - now <= settlementMarginMs) {
      finalize('closing')
      throw channelClosing(channelId, new Date(cancelMs).toISOString())
    }
    onDisputeDetected?.({
      channelId,
      cancelAfter: new Date(cancelMs).toISOString(),
      balance: meta.amount,
    })
  }
}

/**
 * Require a `SettleDelay` long enough for this server to react to a close.
 *
 * After the funder initiates close, `SettleDelay` is the only window in which
 * the recipient can still redeem. A short delay means the funder can close and
 * reclaim unredeemed value faster than the sweeper notices, so the field was
 * worth reading rather than merely retaining.
 *
 * A lookup that omits the field is not treated as a failure: custom
 * `channelLookup` implementations may not surface it, and the destination and
 * funding checks still apply.
 */
function assertSettleDelay(params: {
  channelId: string
  meta: CachedChannelMeta
  minSettleDelay: number
}): void {
  const { channelId, meta, minSettleDelay } = params
  if (minSettleDelay <= 0) return
  if (meta.settleDelay === null) return
  if (meta.settleDelay < minSettleDelay) {
    throw channelSettleDelayTooShort(channelId, meta.settleDelay, minSettleDelay)
  }
}

/** XRPL ripple-epoch seconds to Unix milliseconds. */
function rippleTimeToMs(rippleSeconds: number): number {
  const rippleEpoch = 946_684_800
  return (rippleSeconds + rippleEpoch) * 1000
}

/** Extract channelId from PaymentChannelCreate metadata. */
function extractChannelIdFromMeta(meta: any): string {
  const nodes = meta.AffectedNodes ?? []
  for (const node of nodes) {
    if (node.CreatedNode?.LedgerEntryType === 'PayChannel') {
      return node.CreatedNode.LedgerIndex
    }
  }
  throw new Error('Could not find PayChannel in transaction metadata')
}

/** Exposure snapshot passed to the `onVoucherAccepted` callback. */
export type ChannelVoucherState = {
  channelId: string
  /** Cumulative just credited, in drops. */
  cumulative: string
  /** Total funded on the channel, in drops. */
  fundedDrops: string
  /** Funded minus cumulative: what a close would still yield, in drops. */
  remainingDrops: string
  /** `Expiration` or `CancelAfter`, whichever is set, as ISO-8601. */
  closesAt?: string
}

/** Dispute state passed to onDisputeDetected callback. */
export type ChannelDisputeState = {
  channelId: string
  cancelAfter: string
  balance: string
}

export declare namespace channel {
  export type Parameters = ChannelServerConfig & {
    /**
     * Store for replay protection and cumulative tracking. Must support atomic
     * compare-and-set, which `Store.memory()`, `Store.redis()`,
     * `Store.upstash()` and `Store.cloudflare()` all do.
     */
    store?: Store.AtomicStore
    /** Require a store for replay protection. @default true */
    requireStore?: boolean
    /**
     * Attestation of how the store is shared. Required on mainnet and whenever
     * `NODE_ENV=production`, where an undeclared or `process-local` store is
     * refused: a high-water mark that is not shared across replicas lets the
     * same voucher be credited once per process.
     */
    storeDurability?: StoreDurability
    /**
     * Permit a non-`wss:` `rpcUrl`. Loopback hosts are always allowed without
     * this flag. @default false
     */
    allowInsecureTransport?: boolean
    /**
     * Verify channel existence, balance, and expiration on-chain. The first
     * voucher per channel hits the ledger; subsequent vouchers reuse cached
     * metadata until {@link channelMetadataTtlMs} elapses or the cumulative
     * exceeds the cached balance (re-fetch to detect a PaymentChannelFund top-up).
     * @default true
     */
    verifyChannelOnChain?: boolean
    /**
     * Acknowledge running with `verifyChannelOnChain: false`.
     *
     * Without on-chain verification the only remaining check is the claim
     * signature, which proves the funder signed something -- not that the
     * channel exists, pays this recipient, is funded, or is still open. Required
     * because that is a decision worth making explicitly.
     *
     * @default false
     */
    allowUnverifiedChannels?: boolean
    /**
     * Minimum on-chain `SettleDelay`, in seconds. `0` disables the check.
     *
     * The window in which the recipient can still redeem after the funder
     * initiates close. Below this, the funder could reclaim unredeemed value
     * faster than this server notices and submits a claim.
     *
     * @default 3600 (1 hour)
     */
    minSettleDelay?: number
    /**
     * Refuse vouchers once the channel is within this many ms of closing, by
     * `Expiration` or `CancelAfter`. `0` disables the margin.
     *
     * @default 60000 (1 minute)
     */
    settlementMarginMs?: number
    /**
     * Backstop size cap on the credential, in bytes. 0 disables.
     *
     * Only a backstop: mppx has already decoded, parsed and stripped the header
     * by the time this runs, so it measures the stripped result rather than what
     * was parsed. Use `assertCredentialHeaderSize` in middleware for a real
     * pre-parse limit.
     *
     * @default 8192 (8KB)
     */
    maxCredentialSize?: number
    /**
     * Time in ms to cache channel metadata (Amount, Expiration, CancelAfter)
     * after a successful on-chain lookup. Set to 0 to disable caching.
     * @default 60000 (1 minute)
     */
    channelMetadataTtlMs?: number
    /**
     * Override the on-chain channel lookup. The default implementation uses
     * xrpl.js + `ledger_entry`. Set to inject a custom resolver (e.g. for
     * testing or to share a long-lived Client across verifies).
     */
    channelLookup?: ChannelLookup
    /** Called when a unilateral close is detected on-chain (CancelAfter set). */
    onDisputeDetected?: (state: ChannelDisputeState) => void
    /**
     * Called after each accepted voucher with the channel's remaining
     * redeemable value and close time.
     *
     * Use it to bound unsettled exposure: an accepted voucher is a claim, not
     * settled funds, and redemption depends on the channel staying open and
     * funded. Only fires when on-chain verification is enabled, since the
     * figures come from ledger state.
     */
    onVoucherAccepted?: (state: ChannelVoucherState) => void
    /**
     * Recipient (channel destination) wallet. Required to enable
     * server-side {@link channel.AutoCloseConfig | auto-close}: the
     * SDK signs an on-chain `PaymentChannelClaim` with the latest
     * voucher whenever a channel goes idle, then marks it finalized
     * in the store so subsequent vouchers are rejected.
     *
     * Aligns the SDK with the MPP spec's session-close semantics
     * (see https://mpp.dev/payment-methods/tempo/session and
     * /stellar/session): "Either party can close the channel. The
     * server calls close() ... with the highest voucher".
     */
    wallet?: Wallet
    /**
     * Recipient family seed. Alternative to {@link wallet}.
     */
    seed?: string
    /**
     * Server-side auto-close behavior.
     *
     * - `true` (or omitted when a {@link wallet} is provided):
     *   start a background sweeper with default settings.
     * - `false`: disable auto-close entirely.
     * - Object: enable with custom settings.
     *
     * When enabled, the sweeper periodically scans channels opened
     * through this method instance. For each channel that has been
     * idle (no new voucher) for {@link AutoCloseConfig.idleMs}, it
     * submits a `PaymentChannelClaim` for the latest cumulative voucher
     * and marks the channel finalized.
     *
     * The claim carries `tfClose`, which the ledger accepts from the
     * destination as well as the source. Submitted by the destination it
     * closes the channel immediately and returns the unspent deposit to
     * the funder, so the sweep both collects what was earned and frees
     * the funder's owner reserve in one transaction.
     */
    autoClose?: boolean | AutoCloseConfig
  }

  /** Configuration for the server-side auto-close sweeper. */
  export type AutoCloseConfig = {
    /**
     * Wait this long with no new voucher activity before closing a
     * channel. Set high enough to avoid closing in the middle of a
     * conversation; low enough to recover funds quickly on disconnect.
     * @default 30000 (30s)
     */
    idleMs?: number
    /**
     * How often the sweeper scans active channels.
     * @default 10000 (10s)
     */
    sweepIntervalMs?: number
    /** Called after a successful auto-close. */
    onClose?: (info: { channelId: string; cumulative: string; txHash: string }) => void
    /** Called when an auto-close attempt fails. Defaults to `console.warn`. */
    onError?: (err: { channelId: string; error: Error }) => void
  }

  /** Return type of {@link channel} with the optional `dispose()` handle. */
  export type MethodWithDispose = ReturnType<typeof Method.toServer<typeof ChannelMethod>> & {
    /** Stop the auto-close sweeper. No-op if auto-close was disabled. */
    dispose: () => void
  }
}

/**
 * Close a PayChannel on-chain.
 *
 * Both parties may close, and the ledger treats them differently:
 * - **Destination (recipient)**: the claim settles and the channel is deleted
 *   immediately, with any unspent deposit returned to the funder.
 * - **Source (funder)**: the claim settles and closure is scheduled, taking
 *   effect once `SettleDelay` has elapsed. The channel survives until then, so
 *   the destination keeps its window to redeem.
 *
 * The channel is looked up on-chain to establish the caller's role. Anyone who
 * is neither party is rejected here rather than by the ledger.
 */
export async function close(params: {
  /** Wallet of the closer (funder or recipient). Preferred over `seed`. */
  wallet?: Wallet
  /** Family seed of the closer. Kept for backward compatibility -- prefer `wallet`. */
  seed?: string
  channelId: string
  amount: string
  signature: string
  /** The channel's public key (from PaymentChannelCreate). Required for signature verification. */
  channelPublicKey: string
  network?: NetworkId
  rpcUrl?: string
  /** Store to mark the channel as finalized after close. */
  store?: Store.AtomicStore
}): Promise<{ txHash: string }> {
  const {
    wallet: walletInput,
    seed,
    channelId,
    amount,
    signature,
    channelPublicKey,
    network = 'testnet',
    rpcUrl,
    store: closeStore,
  } = params

  const wallet = resolveWallet({ wallet: walletInput, seed })
  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    const channelObj = await lookupChannel(client, channelId)
    const isSource = channelObj?.Account === wallet.address
    const isDestination = channelObj?.Destination === wallet.address

    // The ledger accepts `tfClose` from the source and from the destination and
    // from nobody else. Checking here turns a third party's attempt into a typed
    // error instead of a raw tec after a round trip and a fee.
    if (channelObj && !isSource && !isDestination) {
      throw verificationFailed(
        'CHANNEL_DESTINATION_MISMATCH',
        `Channel ${channelId} is funded by ${channelObj.Account} and pays ` +
          `${channelObj.Destination}. ${wallet.address} is neither, so it cannot close it.`,
      )
    }

    // tfClose is 0x00020000. 0x00010000 is tfRenew, which clears the channel's
    // Expiration -- the opposite of closing, and silently so: the claim still
    // settles, so the transaction succeeds and the channel quietly survives.
    const TF_CLOSE = 0x00020000

    const channelClaim = {
      TransactionType: 'PaymentChannelClaim' as const,
      Account: wallet.address,
      Channel: channelId,
      Balance: amount,
      Amount: amount,
      Signature: signature.toUpperCase(),
      PublicKey: channelPublicKey,
      SourceTag: MPP_SOURCE_TAG,
      Flags: TF_CLOSE,
    }

    const result = await client.submitAndWait(channelClaim, { wallet: wallet._xrplWallet })
    const meta = result.result.meta as any

    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`PaymentChannelClaim (close) failed: ${meta?.TransactionResult ?? 'unknown'}`)
    }

    if (closeStore) {
      await closeStore.put(storeKeys(network).channelFinalized(channelId), {
        reason: 'closed',
        txHash: result.result.hash,
        timestamp: Date.now(),
      })
    }

    return { txHash: result.result.hash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Server-side "close" of a PayChannel using the latest voucher in the store.
 *
 * Implements the server-initiated session-close pattern from the MPP spec
 * (see https://mpp.dev/payment-methods/tempo/session and
 * https://mpp.dev/payment-methods/stellar/session): the server reads the
 * highest cumulative voucher it has persisted and submits a single on-chain
 * transaction to settle.
 *
 * **XRPL specifics** (vs. Tempo/Stellar smart-contract close):
 * - A single `PaymentChannelClaim` with `tfClose` does the whole job: the
 *   cumulative amount moves to the destination, the channel entry is deleted,
 *   and the unspent deposit returns to the funder. The ledger accepts the flag
 *   from the destination, which closes immediately.
 * - The channel is also marked `finalized` in the store, so any further voucher
 *   credential is rejected with `CHANNEL_EXPIRED` without a ledger read.
 * - `cancelAfter` at channel creation remains worth setting, but as a backstop
 *   for a server that never runs this path at all, not as the only way the
 *   funder's deposit comes back.
 *
 * Returns `null` (no on-chain submission) when there is nothing to claim:
 * the channel is already finalized, no voucher has been received, or the
 * recorded cumulative was already redeemed.
 */
export async function closeFromStore(params: {
  /** Recipient wallet. Preferred over `seed`. */
  wallet?: Wallet
  /** Recipient family seed. Kept for backward compatibility -- prefer `wallet`. */
  seed?: string
  /** Channel to close. */
  channelId: string
  /** Funder publicKey (taken from the original `PaymentChannelCreate`). */
  channelPublicKey: string
  /** Store the voucher was persisted to. */
  store: ReplayStore
  network?: NetworkId
  rpcUrl?: string
}): Promise<{ txHash: string; cumulative: string } | null> {
  const {
    wallet: walletInput,
    seed,
    channelId,
    channelPublicKey,
    store,
    network = 'testnet',
    rpcUrl,
  } = params

  const wallet = resolveWallet({ wallet: walletInput, seed })

  const keys = storeKeys(network)

  const finalized = await store.get(keys.channelFinalized(channelId))
  if (finalized) return null

  // Parse both store reads: this path signs an on-chain PaymentChannelClaim
  // from whatever cumulative it finds, so a malformed value must not reach it.
  const state = parseOrNull(StoredHighWater, await store.get(keys.channel(channelId)))
  if (!state?.signature || BigInt(state.cumulative) === 0n) return null

  const redeemed = parseOrNull(StoredRedeemed, await store.get(keys.channelRedeemed(channelId)))
  if (redeemed && BigInt(redeemed.cumulative) >= BigInt(state.cumulative)) return null

  const result = await close({
    wallet,
    channelId,
    amount: state.cumulative,
    signature: state.signature,
    channelPublicKey,
    network,
    rpcUrl,
    store,
  })

  await store.put(keys.channelRedeemed(channelId), {
    cumulative: state.cumulative,
    txHash: result.txHash,
    timestamp: Date.now(),
  })

  return { txHash: result.txHash, cumulative: state.cumulative }
}

/**
 * Resolve auto-close configuration. Returns `null` when disabled.
 *
 * Default is "auto-enable when a wallet was provided": this gives the
 * advertised "user doesn't need to wire anything" UX. Pass `false`
 * explicitly to opt out.
 */
function resolveAutoCloseConfig(
  input: boolean | channel.AutoCloseConfig | undefined,
  hasWallet: boolean,
): Required<channel.AutoCloseConfig> | null {
  if (input === false) return null
  if (input === undefined && !hasWallet) return null
  const cfg = typeof input === 'object' ? input : {}
  return {
    idleMs: cfg.idleMs ?? 30_000,
    sweepIntervalMs: cfg.sweepIntervalMs ?? 10_000,
    onClose: cfg.onClose ?? (() => {}),
    onError:
      cfg.onError ??
      ((err) => {
        console.warn(
          `[xrpl-mpp-sdk] auto-close failed for channel ${err.channelId}: ${err.error.message}`,
        )
      }),
  }
}

/**
 * Background scanner that closes idle channels via {@link closeFromStore}.
 *
 * - One scan every `sweepIntervalMs`. Re-entrant scans are guarded by a
 *   `busy` flag so a slow on-chain submit can't pile up overlapping sweeps.
 * - `setInterval` is unref'd, so the sweeper alone never keeps the
 *   Node process alive.
 * - Errors per channel are isolated: a failing close on one channel does
 *   not stop the loop nor affect other channels.
 */
function startAutoCloseSweeper(args: {
  wallet: Wallet
  store: ReplayStore
  network: NetworkId
  rpcUrl: string
  activeChannels: Map<string, string>
  config: Required<channel.AutoCloseConfig>
}): () => void {
  const { wallet, store, network, rpcUrl, activeChannels, config } = args
  const keys = storeKeys(network)
  let busy = false
  const interval = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      for (const [channelId, channelPublicKey] of Array.from(activeChannels.entries())) {
        try {
          const finalized = await store.get(keys.channelFinalized(channelId))
          if (finalized) {
            activeChannels.delete(channelId)
            continue
          }
          const state = parseOrNull(StoredHighWater, await store.get(keys.channel(channelId)))
          if (!state?.signature || BigInt(state.cumulative) === 0n) continue
          const age = Date.now() - (state.timestamp ?? 0)
          if (age < config.idleMs) continue

          const redeemed = parseOrNull(
            StoredRedeemed,
            await store.get(keys.channelRedeemed(channelId)),
          )
          if (redeemed && BigInt(redeemed.cumulative) >= BigInt(state.cumulative)) {
            activeChannels.delete(channelId)
            continue
          }

          const result = await closeFromStore({
            wallet,
            channelId,
            channelPublicKey,
            store,
            network,
            rpcUrl,
          })
          if (result) {
            config.onClose({ channelId, ...result })
            activeChannels.delete(channelId)
          }
        } catch (error: unknown) {
          const wrapped = error instanceof Error ? error : new Error(String(error))
          config.onError({ channelId, error: wrapped })
        }
      }
    } finally {
      busy = false
    }
  }, config.sweepIntervalMs)

  // Don't keep the event loop alive solely for the sweeper -- the user's
  // HTTP server is what should hold the process open.
  interval.unref?.()

  return () => clearInterval(interval)
}

/**
 * Look up a PayChannel object on-chain by channel ID.
 */
async function lookupChannel(
  client: Client,
  channelId: string,
): Promise<PayChannelLedgerEntry | null> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      index: channelId,
    } as any)
    const node = (response.result as { node?: unknown }).node
    if (node === undefined || node === null) return null
    // Parse the node's answer before any of it reaches a party or balance
    // check. A malformed entry is treated as absent, which fails closed.
    const parsed = PayChannelEntry.safeParse(node)
    if (!parsed.success) {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Malformed PayChannel entry for ${channelId} -- the node returned an unexpected shape`,
      )
    }
    return parsed.data as PayChannelLedgerEntry
  } catch (err: any) {
    if (err?.data?.error === 'entryNotFound') return null
    throw err
  }
}
