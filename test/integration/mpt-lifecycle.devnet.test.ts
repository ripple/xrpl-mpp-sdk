import { describe, expect, it } from 'vitest'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import { IT_NETWORK } from './devnet-helpers.js'

/**
 * Real-devnet exercise of the MPT-related Wallet methods that the unit
 * suite mocks: `createToken`, `listIssuedTokens`, `acceptToken(mpt)`,
 * `authorize(holder, mpt)`, `issue(mpt)`, `holdsToken(mpt)`,
 * `listAcceptedTokens` (mixed result).
 *
 * The flow runs as a single sequential `it()` so the same wallets go
 * through the full lifecycle without re-funding. Splitting would either
 * be slow (extra faucet hits) or rely on shared `beforeAll` state which
 * makes assertion failures hard to localise.
 *
 * Gated by the integration runner config (`vitest.integration.config.ts`)
 * and the `pnpm test:integration` script -- it does NOT run in the
 * default unit suite.
 */
describe('integration: MPT lifecycle on devnet', () => {
  const NETWORK = IT_NETWORK

  it('walks an issuer + holder through the permissioned-MPT happy path', async () => {
    const [issuer, holder] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    // ---- 1. Mint a permissioned issuance -------------------------------
    const { mpt, hash: createHash } = await issuer.createToken({
      assetScale: 2,
      maximumAmount: '1000000',
      requireAuthorization: true,
      allowTransfer: true,
      network: NETWORK,
    })
    expect(createHash).toMatch(/^[0-9A-F]{64}$/)
    expect(mpt.mpt_issuance_id).toMatch(/^[0-9A-F]{40,}$/)

    // ---- 2. listIssuedTokens surfaces the freshly created issuance -----
    const issuances = await issuer.listIssuedTokens({ network: NETWORK })
    const issued = issuances.find((i) => i.mpt_issuance_id === mpt.mpt_issuance_id)
    expect(issued).toBeDefined()
    expect(issued?.issuer).toBe(issuer.address)
    expect(issued?.flags.requireAuthorization).toBe(true)
    expect(issued?.flags.canTransfer).toBe(true)
    expect(issued?.outstandingAmount).toBe('0')

    // ---- 3. Holder accepts -> pending_authorization (allowlist) --------
    const accept1 = await holder.acceptToken(mpt, { network: NETWORK })
    expect(accept1.status).toBe('pending_authorization')

    // ---- 4. holdsToken reports authorized=false in pending state -------
    const pendingHolding = await holder.holdsToken(mpt, { network: NETWORK })
    expect(pendingHolding).toBeDefined()
    expect(pendingHolding && 'mpt_issuance_id' in pendingHolding).toBe(true)
    if (pendingHolding && 'mpt_issuance_id' in pendingHolding) {
      expect(pendingHolding.authorized).toBe(false)
      expect(pendingHolding.balance).toBe('0')
    }

    // ---- 5. Issuer authorises the holder --------------------------------
    const auth = await issuer.authorize(holder.address, mpt, { network: NETWORK })
    expect(auth.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 6. acceptToken is idempotent post-authorization ---------------
    const accept2 = await holder.acceptToken(mpt, { network: NETWORK })
    expect(accept2.status).toBe('unchanged')

    // ---- 7. holdsToken now reports authorized=true ---------------------
    const authorisedHolding = await holder.holdsToken(mpt, { network: NETWORK })
    if (authorisedHolding && 'mpt_issuance_id' in authorisedHolding) {
      expect(authorisedHolding.authorized).toBe(true)
    } else {
      throw new Error('Expected MPT holding after authorisation')
    }

    // ---- 8. Issuance via Payment ---------------------------------------
    const issuedTx = await issuer.issue(holder.address, '1000', mpt, { network: NETWORK })
    expect(issuedTx.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 9. listAcceptedTokens picks up the MPT (mixed result) ---------
    const inventory = await holder.listAcceptedTokens({ network: NETWORK })
    const mptRow = inventory.find(
      (t) => t.kind === 'mpt' && t.mpt_issuance_id === mpt.mpt_issuance_id,
    )
    expect(mptRow).toBeDefined()
    expect(mptRow?.kind).toBe('mpt')
    if (mptRow?.kind === 'mpt') {
      expect(mptRow.balance).toBe('1000')
      expect(mptRow.authorized).toBe(true)
      expect(mptRow.locked).toBe(false)
    }
  }, 240_000)
})
