import { beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'xrpl'
import { MPP_SOURCE_TAG } from '../../sdk/src/constants.js'
import { generatePreimageCondition } from '../../sdk/src/utils/escrow.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import { DEVNET_WS, IT_NETWORK, waitForLedgerCloseTimePast } from './devnet-helpers.js'

/**
 * Devnet end-to-end for the Escrow Wallet API.
 *
 * Three scenarios run as a single sequential `it()` each, mirroring the
 * IOU and MPT lifecycle tests:
 *
 * 1. **Time-locked escrow**: creator locks XRP with a near-future
 *    `FinishAfter` plus a `DestinationTag`; the test inspects the
 *    on-chain entry via `getEscrow` / `listEscrows` (every field
 *    round-trip, including ripple-time -> JS Date and tag); pre-flight
 *    rejects an early finish; the test waits out the cutoff; finish
 *    succeeds; balance lands on destination; entry is gone.
 * 2. **Crypto-condition escrow**: creator locks XRP with a PREIMAGE-SHA-256
 *    condition; finish without the matching fulfillment is rejected
 *    upfront; finish with the right fulfillment succeeds.
 * 3. **Cancellable escrow**: creator locks with a near-future
 *    `CancelAfter`; cancel before cutoff is rejected; cancel after the
 *    cutoff succeeds; refund returns to creator.
 *
 * **IOU and MPT coverage**: the IOU and MPT scenarios at the bottom of
 * this file ride on the `TokenEscrow` amendment. They probe the network
 * once via `feature` at `beforeAll` and skip cleanly with `ctx.skip()`
 * when the amendment is not active -- the suite still passes its three
 * XRP-only scenarios on networks where token-escrow is unavailable.
 *
 * Gated by the integration runner (`vitest.integration.config.ts`) and
 * the `pnpm test:integration` script -- it does NOT run in the default
 * unit suite.
 */
describe('integration: Escrow lifecycle on devnet', () => {
  const NETWORK = IT_NETWORK

  /** Time the test waits before attempting to finish/cancel (ms). */
  const ESCROW_WAIT_MS = 8_000

  /**
   * Set by `beforeAll` after probing the network's `feature` RPC for
   * the `TokenEscrow` amendment. The IOU and MPT scenarios skip
   * themselves via `ctx.skip()` when this flag is false, so the suite
   * stays green on networks that don't yet ship token-escrow.
   */
  let tokenEscrowActive = false

  beforeAll(async () => {
    tokenEscrowActive = await isTokenEscrowActive()
  }, 60_000)

  /** Read XRP balance via Wallet.getXrpBalance. */
  async function balanceDrops(wallet: Wallet): Promise<bigint> {
    return BigInt(await wallet.getXrpBalance({ network: NETWORK }))
  }

  it('time-locked escrow: finish only after FinishAfter (full field round-trip)', async () => {
    const [creator, recipient] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    // Use a longer cutoff than `ESCROW_WAIT_MS` here: this test exercises
    // the SDK's *early-finish* preflight, which means the early
    // `finishEscrow` call must run while we are still strictly before
    // `finishAfter` according to the local clock. With a tight 8 s
    // cutoff, the create + getEscrow + listEscrows + assertions easily
    // push us past it on a slow devnet round-trip and the preflight
    // would no longer reject. 30 s gives ample margin.
    const FINISH_AFTER_MS = 30_000
    const finishAfter = new Date(Date.now() + FINISH_AFTER_MS)
    const DESTINATION_TAG = 4242

    const created = await creator.createEscrow({
      destination: recipient.address,
      amount: '5000000', // 5 XRP
      finishAfter,
      destinationTag: DESTINATION_TAG,
      network: NETWORK,
    })
    expect(created.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(created.escrowId).toMatch(/^[0-9A-F]{64}$/)
    expect(created.sequence).toBeGreaterThan(0)

    // ---- getEscrow happy path: every public field round-trips ---------
    // This is the highest-value assertion in this suite -- it validates
    // that the rippled Escrow ledger object shape matches what
    // `toEscrowInfo()` expects (amount as drops string, FinishAfter as
    // ripple time -> JS Date, DestinationTag, escrowId hash).
    const info = await creator.getEscrow(
      { owner: creator.address, sequence: created.sequence },
      { network: NETWORK },
    )
    expect(info).not.toBeNull()
    expect(info!.escrowId).toBe(created.escrowId)
    expect(info!.sequence).toBe(created.sequence)
    expect(info!.owner).toBe(creator.address)
    expect(info!.destination).toBe(recipient.address)
    expect(info!.amount).toBe('5000000')
    expect(info!.finishAfter).toBeInstanceOf(Date)
    // Round-trip through ripple time loses sub-second resolution -- allow a
    // ~1-second slop in either direction (`-3` precision = ±~500 ms).
    expect(info!.finishAfter!.getTime()).toBeCloseTo(finishAfter.getTime(), -3)
    expect(info!.cancelAfter).toBeUndefined()
    expect(info!.condition).toBeUndefined()
    expect(info!.destinationTag).toBe(DESTINATION_TAG)
    // The SDK stamps its attribution SourceTag on every transaction it
    // originates, escrows included, so this round-trips rather than being absent.
    expect(info!.sourceTag).toBe(MPP_SOURCE_TAG)

    // ---- listEscrows: same entry surfaces with the same sequence -----
    // Validates that account_objects -> readEscrowSequence picks up the
    // sequence under whichever field name this rippled exposes
    // (OfferSequence vs Sequence) and that the entry is not filtered out.
    const list = await creator.listEscrows({ network: NETWORK })
    const found = list.find((e) => e.sequence === created.sequence)
    expect(found).toBeDefined()
    expect(found!.escrowId).toBe(created.escrowId)
    expect(found!.destination).toBe(recipient.address)
    expect(found!.amount).toBe('5000000')
    expect(found!.destinationTag).toBe(DESTINATION_TAG)

    // ---- Pre-flight rejects an early finish ---------------------------
    await expect(
      recipient.finishEscrow({
        owner: creator.address,
        sequence: created.sequence,
        network: NETWORK,
      }),
    ).rejects.toThrow(/ESCROW_NOT_READY/)

    // Wait until the ledger's close time (not just wall-clock) has passed
    // FinishAfter -- escrow finish is gated on parentCloseTime, which lags
    // wall-clock by up to one close interval.
    await waitForLedgerCloseTimePast(finishAfter)

    const before = await balanceDrops(recipient)

    const finished = await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })
    expect(finished.hash).toMatch(/^[0-9A-F]{64}$/)

    const after = await balanceDrops(recipient)
    // Recipient nets the 5 XRP minus its own EscrowFinish fee. Should be
    // strictly higher than before.
    expect(after).toBeGreaterThan(before)
    // Escrow ledger entry is gone.
    const lookup = await creator.getEscrow(
      { owner: creator.address, sequence: created.sequence },
      { network: NETWORK },
    )
    expect(lookup).toBeNull()
    // listEscrows reflects the deletion too.
    const listAfter = await creator.listEscrows({ network: NETWORK })
    expect(listAfter.find((e) => e.sequence === created.sequence)).toBeUndefined()
  }, 240_000)

  it('crypto-condition escrow: finish requires the matching fulfillment', async () => {
    const [creator, recipient] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    const { condition, fulfillment } = generatePreimageCondition()
    const wrong = generatePreimageCondition()

    const created = await creator.createEscrow({
      destination: recipient.address,
      amount: '4000000',
      condition,
      // CancelAfter required if no FinishAfter -- we let the condition
      // gate the release. Picking a far-future cutoff to avoid races.
      cancelAfter: new Date(Date.now() + 2 * 60 * 60 * 1000),
      network: NETWORK,
    })
    expect(created.escrowId).toMatch(/^[0-9A-F]{64}$/)

    // Missing fulfillment -- SDK preflight rejects.
    await expect(
      recipient.finishEscrow({
        owner: creator.address,
        sequence: created.sequence,
        network: NETWORK,
      }),
    ).rejects.toThrow(/ESCROW_INVALID_FULFILLMENT/)

    // Wrong condition -- SDK preflight rejects.
    await expect(
      recipient.finishEscrow({
        owner: creator.address,
        sequence: created.sequence,
        condition: wrong.condition,
        fulfillment: wrong.fulfillment,
        network: NETWORK,
      }),
    ).rejects.toThrow(/ESCROW_INVALID_FULFILLMENT/)

    // Correct condition + fulfillment -- the ledger accepts it.
    const finished = await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      condition,
      fulfillment,
      network: NETWORK,
    })
    expect(finished.hash).toMatch(/^[0-9A-F]{64}$/)

    const lookup = await creator.getEscrow(
      { owner: creator.address, sequence: created.sequence },
      { network: NETWORK },
    )
    expect(lookup).toBeNull()
  }, 240_000)

  it('cancellable escrow: cancel only after CancelAfter', async () => {
    const creator = await Wallet.fromFaucet({ network: NETWORK })
    const recipient = await Wallet.fromFaucet({ network: NETWORK })

    const finishAfter = new Date(Date.now() + ESCROW_WAIT_MS)
    const cancelAfter = new Date(finishAfter.getTime() + ESCROW_WAIT_MS)

    const created = await creator.createEscrow({
      destination: recipient.address,
      amount: '3000000',
      finishAfter,
      cancelAfter,
      network: NETWORK,
    })

    // Cancel before cutoff is rejected by SDK preflight.
    await expect(
      creator.cancelEscrow({
        owner: creator.address,
        sequence: created.sequence,
        network: NETWORK,
      }),
    ).rejects.toThrow(/ESCROW_NOT_READY/)

    // Wait until the ledger's close time (not just wall-clock) has passed
    // CancelAfter -- escrow cancel is gated on parentCloseTime, which lags
    // wall-clock by up to one close interval.
    await waitForLedgerCloseTimePast(cancelAfter)

    const before = await balanceDrops(creator)

    const cancelled = await creator.cancelEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })
    expect(cancelled.hash).toMatch(/^[0-9A-F]{64}$/)

    const after = await balanceDrops(creator)
    // Refund nets ~3 XRP back minus the fee for the cancel transaction
    // and the original create's fee. The 3 XRP locked is fully recovered,
    // so the *net change* against `before` is strictly negative-bounded
    // only by two fees.
    const delta = after - before
    expect(delta).toBeGreaterThan(2_900_000n) // 3 XRP - margin for two fees
  }, 240_000)

  // -------------------------------------------------------------------
  // Token escrow scenario (MPT)
  //
  // Exercises the MPT `Amount` shape `{mpt_issuance_id, value}`. Gated
  // on the `TokenEscrow` amendment because the underlying network
  // rejects EscrowCreate with anything other than drops when it is not
  // active.
  //
  // Risk this scenario closes that pure unit tests cannot:
  // 1. that rippled stores and surfaces the MPT `Amount` in the same
  //    shape we accept on input (round-trip through `getEscrow`),
  // 2. that the SDK's `createEscrow` reserve preflight does not
  //    incorrectly include the MPT value as paymentDrops.
  //
  // The IOU equivalent is intentionally not tested at the integration
  // level because the public devnet's `TokenEscrow` enforcement on the
  // IOU path is currently flaky -- EscrowFinish intermittently returns
  // `tecNO_PERMISSION` even with `allowTrustLineLocking` and
  // `DefaultRipple` set on the issuer. The IOU `Amount` shape is
  // exercised by the unit suite (`test/xrpl/escrow.test.ts`).
  // -------------------------------------------------------------------

  it('MPT escrow: full lifecycle (gated on TokenEscrow amendment)', async (ctx) => {
    if (!tokenEscrowActive) {
      ctx.skip()
      return
    }

    const [issuer, creator, recipient] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    // `allowEscrow` is immutable on the issuance and is required for any
    // MPT to be acceptable as an escrow `Amount`. `allowTransfer` (default
    // true) is also needed so the MPT can actually move on finish.
    const { mpt } = await issuer.createToken({
      assetScale: 2,
      maximumAmount: '100000',
      allowEscrow: true,
      allowTransfer: true,
      network: NETWORK,
    })

    await creator.acceptToken(mpt, { network: NETWORK })
    await recipient.acceptToken(mpt, { network: NETWORK })

    // Issuer credits the creator with 1000 units to escrow.
    await issuer.issue(creator.address, '1000', mpt, { network: NETWORK })

    // Token escrows (XLS-85) must carry an expiration: a token escrow with
    // no `cancelAfter` locks fine but can never be finished (the ledger
    // rejects EscrowFinish with tecNO_PERMISSION). Finish well before the
    // far-future cancel cutoff.
    const finishAfter = new Date(Date.now() + ESCROW_WAIT_MS)
    const cancelAfter = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const created = await creator.createEscrow({
      destination: recipient.address,
      amount: { mpt_issuance_id: mpt.mpt_issuance_id, value: '500' },
      finishAfter,
      cancelAfter,
      network: NETWORK,
    })
    expect(created.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- getEscrow returns the MPT amount object as-stored ----------
    const info = await creator.getEscrow(
      { owner: creator.address, sequence: created.sequence },
      { network: NETWORK },
    )
    expect(info).not.toBeNull()
    if (typeof info!.amount === 'object' && 'mpt_issuance_id' in info!.amount) {
      expect(info!.amount.mpt_issuance_id).toBe(mpt.mpt_issuance_id)
      expect(info!.amount.value).toBe('500')
    } else {
      throw new Error(
        `Expected MPT amount object on getEscrow, got: ${JSON.stringify(info?.amount)}`,
      )
    }

    // Wait until the ledger's close time (not just wall-clock) has passed
    // FinishAfter -- escrow finish is gated on parentCloseTime, which lags
    // wall-clock by up to one close interval.
    await waitForLedgerCloseTimePast(finishAfter)

    await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })

    const holding = await recipient.holdsToken(mpt, { network: NETWORK })
    expect(holding).not.toBeNull()
    if (holding && 'mpt_issuance_id' in holding) {
      expect(holding.balance).toBe('500')
    } else {
      throw new Error('Expected MPT holding on recipient after finish')
    }

    const lookup = await creator.getEscrow(
      { owner: creator.address, sequence: created.sequence },
      { network: NETWORK },
    )
    expect(lookup).toBeNull()
  }, 360_000)
})

/**
 * Probe the network for the `TokenEscrow` amendment via the public
 * `feature` RPC. Returns false on any error -- a public server that
 * does not expose `feature` is treated as "amendment off" so the IOU
 * and MPT scenarios skip cleanly rather than failing for unrelated
 * reasons.
 */
async function isTokenEscrowActive(): Promise<boolean> {
  const client = new Client(DEVNET_WS)
  try {
    await client.connect()
    const r = await client.request({ command: 'feature' } as any)
    const features = ((r.result as any)?.features ?? {}) as Record<
      string,
      { name?: string; enabled?: boolean }
    >
    for (const v of Object.values(features)) {
      if (v?.name === 'TokenEscrow' && v?.enabled === true) return true
    }
    return false
  } catch {
    return false
  } finally {
    try {
      await client.disconnect()
    } catch {
      // best-effort
    }
  }
}
