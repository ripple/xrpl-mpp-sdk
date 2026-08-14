import { Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { charge as clientCharge } from '../../sdk/src/client/Charge.js'
import { prepareRecipient, charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import { IT_NETWORK } from './devnet-helpers.js'

/**
 * Auto-setup on devnet: the server creates its own trustline / MPT holding
 * for non-XRP currencies, so an integrator never has to pre-bake the
 * recipient account before accepting payments.
 *
 *   - **autoMPTAuthorize**: MPTs bypass the client-side path resolver, so
 *     the lazy setup inside `verify()` is enough end-to-end.
 *
 *   - **autoTrustline**: IOUs flow through `resolveIouPaymentExtras` on
 *     the client *before* signing, and that resolver requires the
 *     recipient's trustline to already exist. The SDK exposes
 *     `prepareRecipient()` so an integrator can run the setup eagerly at
 *     boot (or on first 402 emission), which is what this test exercises.
 */
describe('integration: charge auto-setup on devnet', () => {
  const NETWORK = IT_NETWORK

  it('autoTrustline: prepareRecipient() creates the trustline before the first IOU charge', async () => {
    const [issuer, recipient, payer] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    const currency = { currency: 'USD', issuer: issuer.address }

    await issuer.enableTransfers({ network: NETWORK })
    await payer.acceptToken(currency, { network: NETWORK, limit: '1000' })
    await issuer.issue(payer.address, '100', currency, { network: NETWORK })

    const before = await recipient.holdsToken(currency, { network: NETWORK })
    expect(before).toBeNull()

    const serverParams = {
      wallet: recipient,
      recipient: recipient.address,
      currency,
      autoTrustline: true,
      autoTrustlineLimit: '1000',
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
    } satisfies Parameters<typeof serverCharge>[0]

    // Eagerly run the recipient-side TrustSet so the client's path
    // resolver finds a viable direct-trustline alternative when the
    // first 402 is issued. Without this call, the client throws
    // PAYMENT_PATH_FAILED before the server ever sees the credential.
    await prepareRecipient(serverParams)

    const afterPrepare = await recipient.holdsToken(currency, { network: NETWORK })
    expect(afterPrepare).not.toBeNull()

    // prepareRecipient is idempotent: a second call is a no-op even
    // though it goes through ensureTrustline again.
    await prepareRecipient(serverParams)

    const challenge = {
      id: `int-auto-tl-${Date.now()}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '10',
        currency: JSON.stringify(currency),
        recipient: recipient.address,
        methodDetails: { network: NETWORK },
      },
    }

    const clientMethod = clientCharge({ wallet: payer, network: NETWORK, preflight: true })
    const credentialBlob = await clientMethod.createCredential({
      challenge: challenge as any,
      context: { mode: 'pull' },
    } as any)
    const credential = Credential.deserialize(credentialBlob)

    const serverMethod = serverCharge(serverParams)

    const receipt = await serverMethod.verify({
      credential: credential as any,
      request: challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('xrpl')
    expect(receipt.reference).toMatch(/^[0-9A-F]{64}$/)
  }, 240_000)

  it('autoMPTAuthorize: server lazily authorizes its MPToken on first MPT verify', async () => {
    const [issuer, recipient, payer] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    // Vanilla issuance: no requireAuthorization so the holder side is
    // sufficient. Auto-setup against a permissioned issuance is the same
    // codepath plus an additional `MPT_NOT_AUTHORIZED` if the issuer-side
    // auth is missing -- that case is covered by `mpt-auth.test.ts` in unit.
    const { mpt } = await issuer.createToken({
      assetScale: 0,
      maximumAmount: '1000000',
      allowTransfer: true,
      network: NETWORK,
    })

    await payer.acceptToken(mpt, { network: NETWORK })
    await issuer.issue(payer.address, '100', mpt, { network: NETWORK })

    // Recipient is intentionally NOT authorized yet -- that's the whole
    // point of autoMPTAuthorize.
    const before = await recipient.holdsToken(mpt, { network: NETWORK })
    expect(before).toBeNull()

    const challenge = {
      id: `int-auto-mpt-${Date.now()}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '10',
        currency: JSON.stringify(mpt),
        recipient: recipient.address,
        methodDetails: { network: NETWORK },
      },
    }

    const clientMethod = clientCharge({ wallet: payer, network: NETWORK, preflight: true })
    const credentialBlob = await clientMethod.createCredential({
      challenge: challenge as any,
      context: { mode: 'pull' },
    } as any)
    const credential = Credential.deserialize(credentialBlob)

    const serverMethod = serverCharge({
      wallet: recipient,
      recipient: recipient.address,
      currency: mpt,
      autoMPTAuthorize: true,
      network: NETWORK,
      store: Store.memory(),
      storeDurability: 'process-local',
    })

    const receipt = await serverMethod.verify({
      credential: credential as any,
      request: challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('xrpl')
    expect(receipt.reference).toMatch(/^[0-9A-F]{64}$/)

    // MPToken holding now exists on the recipient -- proves the
    // holder-side MPTokenAuthorize was issued by the SDK.
    const after = await recipient.holdsToken(mpt, { network: NETWORK })
    expect(after).not.toBeNull()
  }, 240_000)
})
