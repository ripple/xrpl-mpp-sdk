/**
 * One-shot diagnostic: reproduces the MPT escrow lifecycle test
 * on devnet, but logs every transaction hash and the raw rippled
 * meta on the failing EscrowFinish so we can see exactly why
 * tecNO_PERMISSION fires.
 *
 * Run with:
 *   pnpm tsx scripts/diag-mpt-escrow.ts
 */

import { Client } from 'xrpl'
import { Wallet } from '../sdk/src/utils/wallet.js'

const NETWORK = 'devnet' as const
const WS = 'wss://s.devnet.rippletest.net:51233'

function explorer(hash: string): string {
  return `https://devnet.xrpl.org/transactions/${hash}`
}

async function main() {
  console.log('-- Funding three wallets from devnet faucet...')
  const [issuer, creator, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  console.log('issuer    :', issuer.address)
  console.log('creator   :', creator.address)
  console.log('recipient :', recipient.address)

  console.log('\n-- Creating MPT issuance (allowEscrow + allowTransfer)...')
  const { mpt, hash: createIssuanceHash } = await issuer.createToken({
    assetScale: 2,
    maximumAmount: '100000',
    allowEscrow: true,
    allowTransfer: true,
    network: NETWORK,
  })
  console.log('mpt_issuance_id :', mpt.mpt_issuance_id)
  console.log('createIssuance  :', explorer(createIssuanceHash))

  console.log('\n-- creator + recipient acceptToken(mpt)...')
  const acceptCreator = await creator.acceptToken(mpt, { network: NETWORK })
  const acceptRecipient = await recipient.acceptToken(mpt, { network: NETWORK })
  console.log('creator accept   :', JSON.stringify(acceptCreator))
  console.log('recipient accept :', JSON.stringify(acceptRecipient))

  console.log('\n-- issuer.issue(creator, "1000", mpt)...')
  const issueRes = await issuer.issue(creator.address, '1000', mpt, { network: NETWORK })
  console.log('issue tx :', explorer(issueRes.hash))

  // Read state pre-escrow.
  const client = new Client(WS)
  await client.connect()
  try {
    await dumpHoldings(client, 'creator (pre-escrow)', creator.address, mpt.mpt_issuance_id)
    await dumpHoldings(client, 'recipient (pre-escrow)', recipient.address, mpt.mpt_issuance_id)
    await dumpIssuance(client, mpt.mpt_issuance_id)
  } finally {
    await client.disconnect()
  }

  console.log('\n-- creator.createEscrow(MPT amount, finishAfter +8s)...')
  const finishAfter = new Date(Date.now() + 8_000)
  const created = await creator.createEscrow({
    destination: recipient.address,
    amount: { mpt_issuance_id: mpt.mpt_issuance_id, value: '500' },
    finishAfter,
    network: NETWORK,
  })
  console.log('createEscrow tx :', explorer(created.hash))
  console.log('escrowId        :', created.escrowId)
  console.log('sequence        :', created.sequence)

  // Wait out the cutoff.
  const remaining = finishAfter.getTime() - Date.now()
  console.log(`\n-- Waiting ${Math.max(0, remaining + 2_000)}ms for finishAfter...`)
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining + 2_000))

  // Read holdings again pre-finish.
  const client2 = new Client(WS)
  await client2.connect()
  try {
    await dumpHoldings(client2, 'creator (post-create, pre-finish)', creator.address, mpt.mpt_issuance_id)
    await dumpHoldings(client2, 'recipient (post-create, pre-finish)', recipient.address, mpt.mpt_issuance_id)
  } finally {
    await client2.disconnect()
  }

  console.log('\n-- recipient.finishEscrow(...) -- via SDK Wallet API...')
  try {
    const finishRes = await recipient.finishEscrow({
      owner: creator.address,
      sequence: created.sequence,
      network: NETWORK,
    })
    console.log('finish tx hash :', explorer(finishRes.hash))
    console.log('TransactionResult : tesSUCCESS')
  } catch (err: any) {
    console.log('\n=== finishEscrow THREW ===')
    console.log(err?.message ?? err)
    // Re-attempt by hand to capture rippled meta.
    const submitClient = new Client(WS)
    await submitClient.connect()
    try {
      const finishTx: any = {
        TransactionType: 'EscrowFinish',
        Account: recipient.address,
        Owner: creator.address,
        OfferSequence: created.sequence,
      }
      const result = await submitClient.submitAndWait(finishTx, {
        wallet: recipient._xrplWallet,
      })
      console.log('manual retry hash :', explorer(result.result.hash))
      const meta: any = result.result.meta
      console.log('manual TransactionResult :', meta?.TransactionResult)
      if (meta?.TransactionResult !== 'tesSUCCESS') {
        console.log('\n=== RAW META OF FAILED FINISH ===')
        console.log(JSON.stringify(result.result, null, 2))
      }
    } finally {
      await submitClient.disconnect()
    }
  }
}

async function dumpHoldings(
  client: Client,
  label: string,
  account: string,
  issuanceId: string,
): Promise<void> {
  try {
    const r = await client.request({
      command: 'account_objects',
      account,
      type: 'mptoken',
    } as any)
    const objs = (r.result as any).account_objects ?? []
    const found = objs.find((o: any) => o.MPTokenIssuanceID === issuanceId)
    console.log(`${label} MPToken :`, found ? JSON.stringify(found) : '(none)')
  } catch (err: any) {
    console.log(`${label} MPToken : <error ${err?.data?.error ?? err?.message}>`)
  }
}

async function dumpIssuance(client: Client, issuanceId: string): Promise<void> {
  try {
    const r = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
    } as any)
    console.log('issuance entry :', JSON.stringify((r.result as any).node))
  } catch (err: any) {
    console.log('issuance entry : <error', err?.data?.error ?? err?.message, '>')
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
