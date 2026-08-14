import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'xrpl'
import { charge as clientCharge } from '../../sdk/src/client/Charge.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import type { Wallet } from '../../sdk/src/utils/wallet.js'
import { connectDevnet, createFundedWallet, IT_NETWORK } from './devnet-helpers.js'

/**
 * Devnet end-to-end for cross-issuer IOU payments.
 *
 * Topology:
 *   - issuerA emits USD.A
 *   - issuerB emits USD.B
 *   - sender holds USD.A (via trustline + payment from issuerA)
 *   - recipient holds USD.B only (no trustline with issuerA)
 *   - market maker holds trustlines with both issuers and posts an offer
 *     bridging USD.A -> USD.B at parity
 *
 * The SDK must:
 *   1. Detect the cross-issuer scenario.
 *   2. Call ripple_path_find and pick the cheapest path.
 *   3. Set Paths + SendMax on the Payment.
 *   4. Submit successfully (tesSUCCESS).
 *   5. Recipient is credited with the requested USD.B amount.
 */
describe('integration: cross-issuer IOU payment on devnet', () => {
  // Long-lived client kept for the orderbook step (`OfferCreate`) and the
  // closing balance probe via `account_lines`. Everything trustline / payment
  // -related goes through the SDK Wallet API; only DEX primitives still need
  // raw xrpl access because the SDK does not expose them.
  const NETWORK = IT_NETWORK
  let client: Client
  let issuerA: Wallet
  let issuerB: Wallet
  let mm: Wallet
  let sender: Wallet
  let recipient: Wallet

  /**
   * Set by `beforeAll` after the bridge offer is live. The SDK's cross-issuer
   * resolution relies on the network's `ripple_path_find` discovering the
   * USD.A <-> USD.B order-book bridge. The public **testnet** path-find service
   * does not auto-bridge two IOUs that share a currency code but differ by
   * issuer -- an explicit `Paths` payment settles fine, yet `ripple_path_find`
   * returns zero alternatives. **Devnet** resolves it. We probe here and skip
   * the assertion cleanly on networks whose path-find can't see the bridge,
   * so the suite stays green; run with `XRPL_IT_NETWORK=devnet` to exercise it.
   */
  let pathFindResolvesBridge = false

  // Helper: post an OfferCreate from market maker bridging USD.A <-> USD.B.
  // OfferCreate / DEX primitives are the one piece the SDK does not abstract,
  // so this single helper still has to drop down to raw xrpl.
  async function placeBridgeOffer(
    maker: Wallet,
    takerGets: { currency: string; issuer: string; value: string },
    takerPays: { currency: string; issuer: string; value: string },
  ) {
    const tx = {
      TransactionType: 'OfferCreate' as const,
      Account: maker.address,
      TakerGets: takerGets,
      TakerPays: takerPays,
    }
    const r = await client.submitAndWait(tx, { wallet: maker._xrplWallet })
    const meta = r.result.meta as any
    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`OfferCreate failed: ${meta?.TransactionResult}`)
    }
  }

  beforeAll(async () => {
    client = await connectDevnet()
    ;[issuerA, issuerB, mm, sender, recipient] = await Promise.all([
      createFundedWallet(),
      createFundedWallet(),
      createFundedWallet(),
      createFundedWallet(),
      createFundedWallet(),
    ])

    const usdA = { currency: 'USD', issuer: issuerA.address }
    const usdB = { currency: 'USD', issuer: issuerB.address }

    // Issuers need DefaultRipple so their trustlines route. Market maker
    // also needs DefaultRipple so its USD.A and USD.B trustlines can serve
    // as a bridge for the orderbook crossing -- without it the cross-issuer
    // path dries on submit (tecPATH_DRY).
    await Promise.all([
      issuerA.enableTransfers({ network: NETWORK }),
      issuerB.enableTransfers({ network: NETWORK }),
      mm.enableTransfers({ network: NETWORK }),
    ])

    // Trustlines: MM trusts both issuers, sender trusts USD.A only,
    // recipient trusts USD.B only.
    await Promise.all([
      mm.acceptToken(usdA, { network: NETWORK, limit: '10000' }),
      mm.acceptToken(usdB, { network: NETWORK, limit: '10000' }),
      sender.acceptToken(usdA, { network: NETWORK, limit: '10000' }),
      recipient.acceptToken(usdB, { network: NETWORK, limit: '10000' }),
    ])

    // Issuers fund the market maker on each side so it can settle the bridge.
    // Sender starts with 200 USD.A.
    await Promise.all([
      issuerA.issue(mm.address, '5000', usdA, { network: NETWORK }),
      issuerB.issue(mm.address, '5000', usdB, { network: NETWORK }),
      issuerA.issue(sender.address, '200', usdA, { network: NETWORK }),
    ])

    // Market maker posts an offer: takes USD.A, pays USD.B. Parity (1:1) for
    // the test, so realised slippage stays well within the default 50 bps.
    await placeBridgeOffer(
      mm,
      { currency: 'USD', issuer: issuerB.address, value: '500' }, // taker gets USD.B
      { currency: 'USD', issuer: issuerA.address, value: '500' }, // taker pays USD.A
    )

    // Probe whether this network's path-find can discover the bridge (see the
    // `pathFindResolvesBridge` docstring). Best-effort: any error leaves the
    // flag false and the scenario skips.
    try {
      const probe = await client.request({
        command: 'ripple_path_find',
        source_account: sender.address,
        destination_account: recipient.address,
        destination_amount: { currency: 'USD', issuer: issuerB.address, value: '10' },
      } as any)
      pathFindResolvesBridge = (((probe.result as any)?.alternatives as unknown[]) ?? []).length > 0
    } catch {
      pathFindResolvesBridge = false
    }
  }, 360_000)

  afterAll(async () => {
    await client?.disconnect()
  })

  it('sender (holds USD.A) pays recipient (holds USD.B) -- SDK auto-resolves the path', async (ctx) => {
    if (!pathFindResolvesBridge) {
      ctx.skip()
      return
    }

    const challenge = {
      id: `int-cross-issuer-${Date.now()}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '10', // 10 USD.B delivered to recipient
        currency: JSON.stringify({ currency: 'USD', issuer: issuerB.address }),
        recipient: recipient.address,
        methodDetails: { network: NETWORK },
      },
    }

    const sourceAmountSnapshot: { value?: string; currency?: string } = {}
    const cm = clientCharge({
      wallet: sender,
      network: NETWORK,
      preflight: true,
      slippageBps: 50,
      onProgress: (e) => {
        if (e.type === 'paths_resolved') {
          sourceAmountSnapshot.value = e.sourceAmountValue
          sourceAmountSnapshot.currency = e.sourceAmountCurrency
        }
      },
    })

    const credentialBlob = await cm.createCredential({
      challenge: challenge as any,
      context: { mode: 'pull' },
    } as any)
    const cred = Credential.deserialize(credentialBlob)

    const sm = serverCharge({
      recipient: recipient.address,
      currency: { currency: 'USD', issuer: issuerB.address },
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
    })

    const receipt = await sm.verify({
      credential: cred as any,
      request: challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.reference).toMatch(/^[0-9A-F]{64}$/)
    // The path-find should have routed via USD.A on the sender's side.
    expect(sourceAmountSnapshot.currency).toBe('USD')

    // Recipient now holds at least 10 USD.B from issuerB.
    const usdLine = await recipient.holdsToken(
      { currency: 'USD', issuer: issuerB.address },
      { network: NETWORK },
    )
    expect(usdLine).not.toBeNull()
    expect(Number(usdLine?.balance ?? '0')).toBeGreaterThanOrEqual(10)
  }, 360_000)
})
