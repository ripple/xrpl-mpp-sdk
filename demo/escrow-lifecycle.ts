/**
 * Escrow Lifecycle -- All-in-one demo
 *
 * Walks the three escrow scenarios end-to-end on testnet without any env
 * vars. Each scenario uses fail-fix-validate -- attempt the wrong thing
 * first, see the typed SDK error, then perform the correct action and
 * confirm on-chain settlement.
 *
 *   1. Time-locked escrow      -- finish only after FinishAfter.
 *   2. Crypto-condition escrow -- finish requires a matching fulfillment.
 *   3. Cancellable escrow      -- cancel only after CancelAfter (refund).
 *
 * The SDK preflights every operation: reserve coverage on create,
 * FinishAfter / CancelAfter cutoffs, and condition matching. Wrong calls
 * surface as typed `ESCROW_NOT_READY` / `ESCROW_INVALID_FULFILLMENT`
 * instead of leaking raw `tec*` codes.
 *
 * Run: npx tsx demo/escrow-lifecycle.ts
 */
import { Client } from 'xrpl'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { generatePreimageCondition } from '../sdk/src/utils/escrow.js'
import { readValidatedCloseTimeMs } from '../sdk/src/utils/ledger-time.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'

const NETWORK = 'testnet' as const

/** Give up rather than poll forever if the node stops advancing. */
const LEDGER_WAIT_TIMEOUT_MS = 120_000

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until the latest validated ledger has closed past `target`.
 *
 * Escrow cutoffs are judged against that close time, not the local clock, and it
 * lags wall clock by a ledger or two. Sleeping until the wall clock passes the
 * cutoff plus a fixed margin only narrows the race -- the ledger decides when it
 * closes, so this polls the value `finishEscrow` and `cancelEscrow` themselves
 * check.
 */
async function waitUntil(target: Date): Promise<void> {
  const local = target.getTime() - Date.now()
  if (local > 0) await sleep(local)

  const client = new Client(XRPL_RPC_URLS[NETWORK])
  await client.connect()
  try {
    const deadline = Date.now() + LEDGER_WAIT_TIMEOUT_MS
    while ((await readValidatedCloseTimeMs(client)) <= target.getTime()) {
      if (Date.now() > deadline) {
        throw new Error(`validated ledger did not reach ${target.toISOString()} in time`)
      }
      await sleep(1_000)
    }
  } finally {
    await client.disconnect()
  }
}

async function timeLockedScenario(): Promise<void> {
  log.box(['Scenario 1/3 -- Time-locked escrow'])
  log.info('Locks 5 XRP. Finish allowed only after FinishAfter elapses.')
  log.separator()

  log.loading('Funding creator + recipient wallets via the testnet faucet...')
  const [creator, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Creator  ', creator.address)
  log.wallet('Recipient', recipient.address)
  log.separator()

  const FINISH_AFTER_MS = 15_000
  const finishAfter = new Date(Date.now() + FINISH_AFTER_MS)
  const DESTINATION_TAG = 4242

  log.loading(`Creating EscrowCreate (5 XRP, finishAfter +${FINISH_AFTER_MS / 1000}s)...`)
  const created = await creator.createEscrow({
    destination: recipient.address,
    amount: '5000000',
    finishAfter,
    destinationTag: DESTINATION_TAG,
    network: NETWORK,
  })
  log.tx(created.hash, log.explorerLink(created.hash))
  log.key('EscrowID  ', created.escrowId)
  log.key('Sequence  ', String(created.sequence))

  log.verify('Reading the escrow back via getEscrow...')
  const info = await creator.getEscrow(
    { owner: creator.address, sequence: created.sequence },
    { network: NETWORK },
  )
  if (!info) {
    throw new Error('getEscrow returned null right after EscrowCreate landed')
  }
  log.success(
    `getEscrow -> destination=${info.destination}, amount=${info.amount} drops, ` +
      `destinationTag=${info.destinationTag}, finishAfter=${info.finishAfter?.toISOString()}`,
  )

  log.loading('Recipient tries to finish *before* FinishAfter (must fail with ESCROW_NOT_READY)...')
  try {
    await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })
    throw new Error('Early finish unexpectedly succeeded')
  } catch (err) {
    const message = (err as Error).message
    if (!message.includes('ESCROW_NOT_READY')) throw err
    log.error(message)
    log.fix(`Wait until ${finishAfter.toISOString()} -- the SDK preflight is gating us.`)
  }

  log.loading('Waiting for FinishAfter to elapse...')
  await waitUntil(finishAfter)

  log.loading('Recipient finishes the escrow now that FinishAfter has elapsed...')
  const finished = await recipient.finishEscrow({
    owner: creator.address,
    sequence: created.sequence,
    network: NETWORK,
  })
  log.tx(finished.hash, log.explorerLink(finished.hash))

  const lookup = await creator.getEscrow(
    { owner: creator.address, sequence: created.sequence },
    { network: NETWORK },
  )
  if (lookup !== null) throw new Error('Escrow ledger entry should be gone after EscrowFinish')
  log.success('Escrow released. Ledger entry deleted, owner reserve freed.')
  log.separator()
}

async function cryptoConditionScenario(): Promise<void> {
  log.box(['Scenario 2/3 -- Crypto-condition escrow'])
  log.info('Locks 4 XRP behind a PREIMAGE-SHA-256 condition.')
  log.info('Only the holder of the matching fulfillment can finish.')
  log.separator()

  log.loading('Funding creator + recipient wallets via the testnet faucet...')
  const [creator, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Creator  ', creator.address)
  log.wallet('Recipient', recipient.address)
  log.separator()

  log.loading('Generating a fresh PREIMAGE-SHA-256 condition + fulfillment...')
  const { condition, fulfillment } = generatePreimageCondition()
  const wrong = generatePreimageCondition()
  log.key('Condition  ', `${condition.slice(0, 32)}...`)
  log.key('Fulfillment', `${fulfillment.slice(0, 32)}...`)

  log.loading('Creating EscrowCreate (4 XRP, condition gated, cancelAfter +2h)...')
  const created = await creator.createEscrow({
    destination: recipient.address,
    amount: '4000000',
    condition,
    cancelAfter: new Date(Date.now() + 2 * 60 * 60 * 1000),
    network: NETWORK,
  })
  log.tx(created.hash, log.explorerLink(created.hash))
  log.key('EscrowID', created.escrowId)

  log.loading(
    'Recipient tries to finish *without* a fulfillment (must fail with ESCROW_INVALID_FULFILLMENT)...',
  )
  try {
    await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })
    throw new Error('Finish without fulfillment unexpectedly succeeded')
  } catch (err) {
    const message = (err as Error).message
    if (!message.includes('ESCROW_INVALID_FULFILLMENT')) throw err
    log.error(message)
    log.fix('Provide the fulfillment that hashes to the on-chain condition.')
  }

  log.loading('Recipient tries with a *wrong* fulfillment (must fail too)...')
  try {
    await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      condition: wrong.condition,
      fulfillment: wrong.fulfillment,
      network: NETWORK,
    })
    throw new Error('Finish with wrong fulfillment unexpectedly succeeded')
  } catch (err) {
    const message = (err as Error).message
    if (!message.includes('ESCROW_INVALID_FULFILLMENT')) throw err
    log.error(message)
    log.fix('SDK matched the supplied condition against the on-chain one and refused.')
  }

  log.loading('Recipient finishes with the correct fulfillment...')
  const finished = await recipient.finishEscrow({
    owner: creator.address,
    sequence: created.sequence,
    condition,
    fulfillment,
    network: NETWORK,
  })
  log.tx(finished.hash, log.explorerLink(finished.hash))

  const lookup = await creator.getEscrow(
    { owner: creator.address, sequence: created.sequence },
    { network: NETWORK },
  )
  if (lookup !== null) throw new Error('Escrow ledger entry should be gone')
  log.success('Escrow released by the holder of the fulfillment.')
  log.separator()
}

async function cancellableScenario(): Promise<void> {
  log.box(['Scenario 3/3 -- Cancellable escrow (creator refund)'])
  log.info('Locks 3 XRP. Recipient can finish; creator can cancel and refund.')
  log.separator()

  log.loading('Funding creator + recipient wallets via the testnet faucet...')
  const [creator, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Creator  ', creator.address)
  log.wallet('Recipient', recipient.address)
  log.separator()

  const finishAfter = new Date(Date.now() + 5_000)
  const cancelAfter = new Date(finishAfter.getTime() + 10_000)

  log.loading('Creating EscrowCreate (3 XRP, finishAfter +5s, cancelAfter +15s)...')
  const created = await creator.createEscrow({
    destination: recipient.address,
    amount: '3000000',
    finishAfter,
    cancelAfter,
    network: NETWORK,
  })
  log.tx(created.hash, log.explorerLink(created.hash))
  log.key('EscrowID', created.escrowId)

  log.loading('Creator tries to cancel *before* CancelAfter (must fail with ESCROW_NOT_READY)...')
  try {
    await creator.cancelEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })
    throw new Error('Early cancel unexpectedly succeeded')
  } catch (err) {
    const message = (err as Error).message
    if (!message.includes('ESCROW_NOT_READY')) throw err
    log.error(message)
    log.fix(`Wait until ${cancelAfter.toISOString()} for the cancel to be allowed.`)
  }

  log.loading('Waiting for CancelAfter to elapse...')
  await waitUntil(cancelAfter)

  log.loading('Creator cancels the escrow now that CancelAfter has elapsed...')
  const cancelled = await creator.cancelEscrow({
    owner: creator.address,
    sequence: created.sequence,
    network: NETWORK,
  })
  log.tx(cancelled.hash, log.explorerLink(cancelled.hash))

  const lookup = await creator.getEscrow(
    { owner: creator.address, sequence: created.sequence },
    { network: NETWORK },
  )
  if (lookup !== null) throw new Error('Escrow ledger entry should be gone after cancel')
  log.success('Escrow refunded to the creator. Ledger entry deleted.')
  log.separator()
}

async function main(): Promise<void> {
  log.box(['XRPL MPP Demo -- Escrow Lifecycle (all-in-one)'])
  log.info('Three scenarios: time-locked, crypto-condition, cancellable.')
  log.info('Network: testnet. All wallets are ephemeral (faucet-funded).')
  log.separator()

  await timeLockedScenario()
  await cryptoConditionScenario()
  await cancellableScenario()

  log.info('Escrow lifecycle demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`)
  process.exit(1)
})
