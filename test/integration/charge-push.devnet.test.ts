import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { charge as clientCharge } from '../../sdk/src/client/Charge.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import type { Wallet } from '../../sdk/src/utils/wallet.js'
import { createFundedWallet, devnetSource, IT_NETWORK } from './devnet-helpers.js'

/**
 * Push-mode end-to-end on devnet.
 *
 * In push mode, the client signs AND submits the Payment transaction itself,
 * then sends the resulting `tx_hash` to the server inside the credential
 * payload. The server looks up the validated tx on-chain and asserts it
 * matches the challenge (Account, Destination, Amount, currency, source DID,
 * tags / memos when set, no `tfPartialPayment`, ...).
 *
 * This test guarantees that:
 *   1. The client emits a credential with `payload: { type: 'hash', hash }`
 *      when `context.mode === 'push'`.
 *   2. The server's `verifyPush` codepath fetches the validated tx, runs the
 *      same source-binding / destination / amount checks as pull, and emits
 *      a successful Receipt referencing the on-chain tx hash.
 *   3. The replay-protection store sees the tx hash and rejects a second
 *      verify for the same credential.
 *
 * Pull mode is exercised by `charge.devnet.test.ts`; this file specifically
 * locks the push-mode path which is otherwise only covered by mocked unit
 * tests.
 */
describe('integration: XRP charge (push mode) on devnet', () => {
  const NETWORK = IT_NETWORK
  let payer: Wallet
  let recipient: Wallet

  beforeAll(async () => {
    ;[payer, recipient] = await Promise.all([createFundedWallet(), createFundedWallet()])
  })

  afterAll(async () => {
    // Wallet helpers manage their own short-lived clients; nothing to close.
  })

  it('client signs+submits, server looks up the on-chain tx and emits a receipt', async () => {
    const amountDrops = '500000' // 0.5 XRP

    const challenge = {
      id: `int-charge-push-${Date.now()}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: amountDrops,
        currency: 'XRP',
        recipient: recipient.address,
        methodDetails: { network: NETWORK },
      },
    }

    const clientMethod = clientCharge({
      wallet: payer,
      mode: 'push',
      network: NETWORK,
      preflight: true,
    })

    // In push mode `createCredential` signs AND submits the tx, then returns
    // a credential whose payload is `{ type: 'hash', hash }`.
    const credentialBlob = await clientMethod.createCredential({
      challenge: challenge as any,
      // The client-side default is 'pull'; the per-call context flips it.
      context: { mode: 'push' },
    } as any)

    const credential = Credential.deserialize(credentialBlob)
    expect(credential.source).toBe(devnetSource(payer))

    // Sanity: payload should carry the on-chain tx hash, not a tx blob.
    const payload = (credential as any).payload
    expect(payload?.type).toBe('hash')
    expect(payload?.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(payload?.blob).toBeUndefined()

    // Shared store so we can also exercise replay protection below.
    const store = Store.memory()
    const serverMethod = serverCharge({
      recipient: recipient.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })

    const receipt = await serverMethod.verify({
      credential: credential as any,
      request: challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('xrpl')
    // The receipt reference is the same on-chain tx hash the client submitted.
    expect(receipt.reference).toBe(payload.hash)
    expect(receipt.reference).toMatch(/^[0-9A-F]{64}$/)

    // Replay: re-verifying the *same* credential against the same store must
    // be rejected. The store keys off `xrpl:tx:{hash}` and `xrpl:challenge:{id}`.
    await expect(
      serverMethod.verify({
        credential: credential as any,
        request: challenge.request,
      }),
    ).rejects.toThrow(/REPLAY_DETECTED/i)
  }, 180_000)
})
