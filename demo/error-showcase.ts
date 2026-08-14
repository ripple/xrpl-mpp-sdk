/**
 * Error Showcase -- fail-fix-validate for every SDK error path
 *
 * Generates all wallets via testnet faucet. Each case:
 *   attempt (expect failure) -> display error -> fix -> retry (expect success) -> print tx
 *
 * Run: npx tsx demo/error-showcase.ts
 */
import { Credential, Store } from 'mppx'
import { Client } from 'xrpl'
import { openChannel } from '../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../sdk/src/channel/server/Channel.js'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { fromDrops } from '../sdk/src/Methods.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'
import { storeKeys } from '../sdk/src/utils/keys.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'

const NETWORK = 'testnet'

/** tfPartialPayment flag bit. Used in the PARTIAL_PAYMENT_REJECTED case to
 * forge a tx the SDK should refuse on the server side. */
const TF_PARTIAL_PAYMENT = 0x00020000

let caseNum = 0
const total = 16

function header(name: string) {
  caseNum++
  log.separator()
  log.box([`[${caseNum}/${total}] ${name}`])
}

async function runChargeFlow(params: {
  clientSeed: string
  recipient: string
  amount: string
  currency: string
  serverCurrency?: any
}): Promise<{ hash: string }> {
  const { clientSeed, recipient, amount, currency, serverCurrency } = params
  const store = Store.memory()
  const srv = serverCharge({ recipient, currency: serverCurrency, network: NETWORK, store })
  const cli = clientCharge({ seed: clientSeed, mode: 'pull', network: NETWORK })

  const challenge = {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'error-showcase',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    expires: new Date(Date.now() + 300_000).toISOString(),
    request: {
      amount,
      currency,
      recipient,
      methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
    },
  }

  const credentialStr = await cli.createCredential({ challenge, context: {} })
  const credential = Credential.deserialize(credentialStr)
  const receipt = await srv.verify({ credential: credential as any, request: challenge.request })
  return { hash: receipt.reference }
}

async function main() {
  log.box(['XRPL MPP -- Error Showcase'])
  log.separator()
  log.loading('Generating wallets on XRPL testnet...')

  const [mainWallet, recipientWallet, issuerWallet, channelFunder, channelReceiver] =
    await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])
  const wrongSigner = Wallet.generate()

  log.wallet('Main', mainWallet.address)
  log.wallet('Recipient', recipientWallet.address)
  log.wallet('Issuer', issuerWallet.address)
  log.wallet('Channel funder', channelFunder.address)
  log.wallet('Channel receiver', channelReceiver.address)

  // ---- CASE 1 ----
  header('INSUFFICIENT_BALANCE')
  {
    log.loading('Attempting payment with unfunded wallet...')
    const unfunded = Wallet.generate()
    try {
      await runChargeFlow({
        clientSeed: unfunded.seed!,
        recipient: recipientWallet.address,
        amount: '1000000',
        currency: 'XRP',
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Funding wallet via testnet faucet...')
    await unfunded.fundFromFaucet({ network: NETWORK })

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: unfunded.seed!,
        recipient: recipientWallet.address,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 2 ----
  header('RECIPIENT_NOT_FOUND')
  {
    const nonExistent = Wallet.generate()
    log.loading(`Paying to non-existent address ${nonExistent.address}...`)
    try {
      await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: nonExistent.address,
        amount: '1000000',
        currency: 'XRP',
      })
      log.error('Expected error but succeeded (1 XRP >= reserve, account auto-created)')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Funding destination account...')
    await nonExistent.fundFromFaucet({ network: NETWORK })

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: nonExistent.address,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 3 ----
  header('AMOUNT_MISMATCH')
  {
    log.loading('Client signs 1 drop, server expects 1,000,000 drops...')
    const store = Store.memory()
    const srv = serverCharge({ recipient: recipientWallet.address, network: NETWORK, store })
    const cli = clientCharge({ seed: mainWallet.seed!, mode: 'pull', network: NETWORK })

    const wrongChallenge = {
      id: `err-amt-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '1',
        currency: 'XRP',
        recipient: recipientWallet.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
      },
    }
    const credStr = await cli.createCredential({ challenge: wrongChallenge, context: {} })
    const cred = Credential.deserialize(credStr)

    try {
      await srv.verify({
        credential: cred as any,
        request: { ...wrongChallenge.request, amount: '1000000' },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Client signs correct amount...')
    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: recipientWallet.address,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 4 ----
  header('MISSING_TRUSTLINE')
  {
    const usd = { currency: 'USD', issuer: issuerWallet.address }
    log.loading('Setting up issuer with DefaultRipple...')
    await issuerWallet.enableTransfers({ network: NETWORK })
    await recipientWallet.acceptToken(usd, { network: NETWORK, limit: '1000000' })

    const noTrustClient = await Wallet.fromFaucet({ network: NETWORK })
    log.loading('Attempting IOU payment without client trustline...')
    const currencyJson = JSON.stringify(usd)
    try {
      await runChargeFlow({
        clientSeed: noTrustClient.seed!,
        recipient: recipientWallet.address,
        amount: '10',
        currency: currencyJson,
        serverCurrency: usd,
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Creating trustline + issuing tokens...')
    await noTrustClient.acceptToken(usd, { network: NETWORK, limit: '1000000' })
    await issuerWallet.issue(noTrustClient.address, '1000', usd, { network: NETWORK })

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: noTrustClient.seed!,
        recipient: recipientWallet.address,
        amount: '10',
        currency: currencyJson,
        serverCurrency: usd,
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 5 ----
  header('PAYMENT_PATH_FAILED')
  {
    const [badIssuer, pathClient, pathRecipient] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])
    const tst = { currency: 'TST', issuer: badIssuer.address }

    // The SDK guards against creating a trustline against an issuer that has
    // not enabled DefaultRipple -- payments through it would later fail with
    // tecPATH_DRY. So the error surfaces at trustline-creation time rather
    // than at payment time, which is strictly better but makes for a different
    // narrative than the raw-XRPL flow.
    log.loading('Issuer has rippling DISABLED -- attempting to create trustline...')
    try {
      await pathClient.acceptToken(tst, { network: NETWORK, limit: '1000000' })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Enabling DefaultRipple on issuer + creating trustlines...')
    await badIssuer.enableTransfers({ network: NETWORK })
    await Promise.all([
      pathClient.acceptToken(tst, { network: NETWORK, limit: '1000000' }),
      pathRecipient.acceptToken(tst, { network: NETWORK, limit: '1000000' }),
    ])
    await badIssuer.issue(pathClient.address, '1000', tst, { network: NETWORK })

    log.loading('Retrying payment with rippling enabled...')
    const currencyJson = JSON.stringify(tst)
    try {
      const { hash } = await runChargeFlow({
        clientSeed: pathClient.seed!,
        recipient: pathRecipient.address,
        amount: '10',
        currency: currencyJson,
        serverCurrency: tst,
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message.slice(0, 120)}`)
    }
  }

  // ---- CASE 6 ----
  header('INSUFFICIENT_IOU_BALANCE')
  {
    const usd = { currency: 'USD', issuer: issuerWallet.address }
    const emptyClient = await Wallet.fromFaucet({ network: NETWORK })
    await emptyClient.acceptToken(usd, { network: NETWORK, limit: '1000000' })

    log.loading('Client has trustline but zero token balance...')
    const currencyJson = JSON.stringify(usd)
    try {
      await runChargeFlow({
        clientSeed: emptyClient.seed!,
        recipient: recipientWallet.address,
        amount: '10',
        currency: currencyJson,
        serverCurrency: usd,
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Issuer sends tokens to client...')
    await issuerWallet.issue(emptyClient.address, '1000', usd, { network: NETWORK })

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: emptyClient.seed!,
        recipient: recipientWallet.address,
        amount: '10',
        currency: currencyJson,
        serverCurrency: usd,
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 7 ----
  header('MPT_NOT_AUTHORIZED')
  {
    log.loading('Creating MPT issuance...')
    const [mptIssuer, mptRecipient, mptClient] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])
    const { mpt } = await mptIssuer.createToken({
      assetScale: 2,
      maximumAmount: '100000000',
      network: NETWORK,
    })
    await mptRecipient.acceptToken(mpt, { network: NETWORK })

    log.loading('Attempting MPT payment without client authorization...')
    const currencyJson = JSON.stringify(mpt)
    try {
      await runChargeFlow({
        clientSeed: mptClient.seed!,
        recipient: mptRecipient.address,
        amount: '100',
        currency: currencyJson,
        serverCurrency: mpt,
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Authorizing client + issuing tokens...')
    await mptClient.acceptToken(mpt, { network: NETWORK })
    await mptIssuer.issue(mptClient.address, '10000', mpt, { network: NETWORK })

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mptClient.seed!,
        recipient: mptRecipient.address,
        amount: '100',
        currency: currencyJson,
        serverCurrency: mpt,
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 8 ----
  header('INSUFFICIENT_MPT_BALANCE')
  {
    const [mptIssuer2, mptRecip2, mptEmpty] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])
    const { mpt: mpt2 } = await mptIssuer2.createToken({
      assetScale: 2,
      maximumAmount: '100000000',
      network: NETWORK,
    })
    await Promise.all([
      mptRecip2.acceptToken(mpt2, { network: NETWORK }),
      mptEmpty.acceptToken(mpt2, { network: NETWORK }),
    ])

    log.loading('Client authorized but has zero MPT balance...')
    const currencyJson = JSON.stringify(mpt2)
    try {
      await runChargeFlow({
        clientSeed: mptEmpty.seed!,
        recipient: mptRecip2.address,
        amount: '100',
        currency: currencyJson,
        serverCurrency: mpt2,
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Issuer mints tokens to client...')
    await mptIssuer2.issue(mptEmpty.address, '10000', mpt2, { network: NETWORK })

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mptEmpty.seed!,
        recipient: mptRecip2.address,
        amount: '100',
        currency: currencyJson,
        serverCurrency: mpt2,
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 9 ----
  header('WRONG_SIGNER (channel)')
  {
    log.loading('Opening PayChannel...')
    const { channelId, txHash: createHash } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.address,
      amount: '5000000',
      settleDelay: 3600,
      network: NETWORK,
    })
    log.tx(createHash, log.explorerLink(createHash))

    const store = Store.memory()
    const srvMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      recipient: channelReceiver.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })

    log.loading('Signing claim with WRONG wallet...')
    const wrongSig = wrongSigner.signChannelClaim(channelId, '100000')
    const ch = {
      id: `err-chan-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '100000',
        channelId,
        recipient: channelReceiver.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const wrongCred = Credential.from({
      challenge: ch as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: wrongSig },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })

    try {
      await srvMethod.verify({ credential: wrongCred as any, request: ch.request })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Signing with correct wallet...')
    const correctSig = channelFunder.signChannelClaim(channelId, '100000')
    const correctCred = Credential.from({
      challenge: { ...ch, id: `err-chan-fix-${Date.now()}` } as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: correctSig },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })

    log.loading('Retrying...')
    try {
      const receipt = await srvMethod.verify({
        credential: correctCred as any,
        request: ch.request,
      })
      log.success(`Claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 10 ----
  header('REPLAY_DETECTED (channel)')
  {
    log.loading('Opening PayChannel...')
    const { channelId } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.address,
      amount: '5000000',
      settleDelay: 3600,
      network: NETWORK,
    })

    const store = Store.memory()
    const srvMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      recipient: channelReceiver.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })

    const sig1 = channelFunder.signChannelClaim(channelId, '100000')
    const ch1 = {
      id: `replay-1-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '100000',
        channelId,
        recipient: channelReceiver.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const cred1 = Credential.from({
      challenge: ch1 as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: sig1 },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })
    await srvMethod.verify({ credential: cred1 as any, request: ch1.request })
    log.success('First claim (100,000 drops) accepted')

    log.loading('Replaying same cumulative amount...')
    const ch2 = { ...ch1, id: `replay-2-${Date.now()}` }
    const cred2 = Credential.from({
      challenge: ch2 as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: sig1 },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })
    try {
      await srvMethod.verify({ credential: cred2 as any, request: ch2.request })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Incrementing cumulative to 200,000 drops...')
    const sig2 = channelFunder.signChannelClaim(channelId, '200000')
    const ch3 = { ...ch1, id: `replay-3-${Date.now()}` }
    const cred3 = Credential.from({
      challenge: ch3 as any,
      payload: { action: 'voucher', channelId, amount: '200000', signature: sig2 },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })

    log.loading('Retrying...')
    try {
      const receipt = await srvMethod.verify({ credential: cred3 as any, request: ch3.request })
      log.success(`Claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 11 ----
  header('OVERPAY (channel)')
  {
    log.loading('Opening 1 XRP channel (deposit: 1,000,000 drops)...')
    const { channelId } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.address,
      amount: '1000000',
      settleDelay: 3600,
      network: NETWORK,
    })

    // Use one store for the fail attempt
    const failStore = Store.memory()
    const failMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      recipient: channelReceiver.address,
      network: NETWORK,
      store: failStore,
      storeDurability: 'process-local',
    })

    log.loading('Claiming 2,000,000 drops from a 1,000,000 drop channel...')
    const overSig = channelFunder.signChannelClaim(channelId, '2000000')
    const chOver = {
      id: `over-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '2000000',
        channelId,
        recipient: channelReceiver.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const credOver = Credential.from({
      challenge: chOver as any,
      payload: { action: 'voucher', channelId, amount: '2000000', signature: overSig },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })

    try {
      await failMethod.verify({ credential: credOver as any, request: chOver.request })
      // Signature is valid locally -- the overpay is only caught on-chain at close
      log.error('Signature valid locally, but on-chain close would fail (Balance > deposit)')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    // Fresh store for the retry so the overpay doesn't pollute cumulative tracking
    log.fix('Claiming correct amount (500,000 drops = 0.5 XRP)...')
    const retryStore = Store.memory()
    const retryMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      recipient: channelReceiver.address,
      network: NETWORK,
      store: retryStore,
      storeDurability: 'process-local',
    })

    const goodSig = channelFunder.signChannelClaim(channelId, '500000')
    const chGood = {
      id: `over-fix-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '500000',
        channelId,
        recipient: channelReceiver.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const credGood = Credential.from({
      challenge: chGood as any,
      payload: { action: 'voucher', channelId, amount: '500000', signature: goodSig },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })

    log.loading('Retrying...')
    try {
      const receipt = await retryMethod.verify({
        credential: credGood as any,
        request: chGood.request,
      })
      log.success(`Claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 12 ----
  header('SERVER_REDEEM (channel -- client disappears)')
  {
    log.loading('Opening PayChannel (5 XRP)...')
    const { channelId, txHash: createHash } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.address,
      amount: '5000000',
      settleDelay: 3600,
      network: NETWORK,
    })
    log.tx(createHash, log.explorerLink(createHash))

    const store = Store.memory()
    const srvMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      recipient: channelReceiver.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })

    // Client makes 3 claims then disappears
    let lastAmount = '0'
    for (const cumDrops of ['100000', '200000', '300000']) {
      const sig = channelFunder.signChannelClaim(channelId, cumDrops)
      const ch = {
        id: `redeem-${cumDrops}-${Date.now()}`,
        realm: 'error-showcase',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        request: {
          amount: '100000',
          channelId,
          recipient: channelReceiver.address,
          methodDetails: {
            network: NETWORK,
            reference: crypto.randomUUID(),
            cumulativeAmount: lastAmount,
          },
        },
      }
      const cred = Credential.from({
        challenge: ch as any,
        payload: { action: 'voucher', channelId, amount: cumDrops, signature: sig },
        source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
      })
      await srvMethod.verify({ credential: cred as any, request: ch.request })
      lastAmount = cumDrops
    }
    log.success(`Client made 3 claims (cumulative: ${lastAmount} drops), then disappeared`)

    // Verify the store has the latest signature
    const storeState = (await store.get(storeKeys(NETWORK).channel(channelId))) as any
    log.info(
      `Store has cumulative=${storeState.cumulative}, signature=${storeState.signature.slice(0, 16)}...`,
    )

    // Server redeems using stored signature + its own seed
    log.loading('Server redeems funds on-chain using stored claim...')
    const { close } = await import('../sdk/src/channel/server/Channel.js')
    const { txHash: redeemHash } = await close({
      seed: channelReceiver.seed!,
      channelId,
      amount: storeState.cumulative,
      signature: storeState.signature,
      channelPublicKey: channelFunder.publicKey,
      network: NETWORK,
    })
    log.success('Server redeemed funds on-chain')
    log.tx(redeemHash, log.explorerLink(redeemHash))

    // Verify receiver balance increased
    const receiverBalance = await channelReceiver.getXrpBalance({ network: NETWORK })
    log.info(`Receiver balance: ${fromDrops(receiverBalance)} XRP`)
  }

  // ---- CASE 13 ----
  header('FINALIZED_CHANNEL (credential after close)')
  {
    log.loading('Opening PayChannel (5 XRP)...')
    const { channelId, txHash: createHash } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.address,
      amount: '5000000',
      settleDelay: 3600,
      network: NETWORK,
    })
    log.tx(createHash, log.explorerLink(createHash))

    const store = Store.memory()
    const srvMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      recipient: channelReceiver.address,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
    })

    // Make 1 successful voucher claim
    const cumDrops = '100000'
    const sig = channelFunder.signChannelClaim(channelId, cumDrops)
    const ch = {
      id: `finalized-1-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: cumDrops,
        channelId,
        recipient: channelReceiver.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const cred = Credential.from({
      challenge: ch as any,
      payload: { action: 'voucher', channelId, amount: cumDrops, signature: sig },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })
    await srvMethod.verify({ credential: cred as any, request: ch.request })
    log.success(`First claim accepted (${cumDrops} drops)`)

    // Retrieve stored state for the close
    const storeState = (await store.get(storeKeys(NETWORK).channel(channelId))) as any

    // Server redeems and closes the channel, passing the SAME store
    log.loading('Server closes channel on-chain (with store)...')
    const { txHash: closeHash } = await close({
      seed: channelReceiver.seed!,
      channelId,
      amount: storeState.cumulative,
      signature: storeState.signature,
      channelPublicKey: channelFunder.publicKey,
      network: NETWORK,
      store,
    })
    log.success('Channel closed on-chain')
    log.tx(closeHash, log.explorerLink(closeHash))

    // Attempt another voucher on the finalized channel
    log.loading('Attempting another voucher on finalized channel...')
    const newCum = '200000'
    const newSig = channelFunder.signChannelClaim(channelId, newCum)
    const ch2 = {
      id: `finalized-2-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '100000',
        channelId,
        recipient: channelReceiver.address,
        methodDetails: {
          network: NETWORK,
          reference: crypto.randomUUID(),
          cumulativeAmount: cumDrops,
        },
      },
    }
    const cred2 = Credential.from({
      challenge: ch2 as any,
      payload: { action: 'voucher', channelId, amount: newCum, signature: newSig },
      source: `did:pkh:xrpl:${NETWORK}:${channelFunder.address}`,
    })

    try {
      await srvMethod.verify({ credential: cred2 as any, request: ch2.request })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }
  }

  // ---- CASE 14 ----
  header('INSUFFICIENT_RESERVE')
  {
    log.loading('Funding a fresh wallet via faucet (~100 XRP)...')
    const reserveTester = await Wallet.fromFaucet({ network: NETWORK })
    const initialBalance = await reserveTester.getXrpBalance({ network: NETWORK })
    log.info(`Tester balance: ${fromDrops(initialBalance)} XRP`)

    // Try to open a channel that locks more XRP than the wallet has free
    // after the base + owner reserve. The SDK runs an owner-reserve preflight
    // inside `openChannel` and surfaces a typed INSUFFICIENT_RESERVE before
    // the tx is even signed.
    const oversizedDeposit = '99000000'
    log.loading(
      `Attempting to open a PayChannel locking ${fromDrops(oversizedDeposit)} XRP (would leave the wallet under the reserve floor)...`,
    )
    try {
      await openChannel({
        wallet: reserveTester,
        destination: recipientWallet.address,
        amount: oversizedDeposit,
        settleDelay: 3600,
        network: NETWORK,
      })
      log.error('Expected INSUFFICIENT_RESERVE but the channel opened anyway.')
    } catch (err: any) {
      log.error(err.message.slice(0, 220))
    }

    log.fix('Top up the wallet via the faucet to cover the deposit + owner reserve...')
    await reserveTester.fundFromFaucet({ network: NETWORK })
    const toppedBalance = await reserveTester.getXrpBalance({ network: NETWORK })
    log.info(`Tester balance now: ${fromDrops(toppedBalance)} XRP`)

    log.loading('Retrying the channel open with the same deposit...')
    try {
      const { channelId, txHash } = await openChannel({
        wallet: reserveTester,
        destination: recipientWallet.address,
        amount: oversizedDeposit,
        settleDelay: 3600,
        network: NETWORK,
      })
      log.success(`Channel opened: ${channelId}`)
      log.tx(txHash, log.explorerLink(txHash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message.slice(0, 200)}`)
    }
  }

  // ---- CASE 15 ----
  header('PARTIAL_PAYMENT_REJECTED')
  {
    // The SDK's high-level Wallet API never sets tfPartialPayment, so we have
    // to drop down to xrpl.js to simulate a malicious client that hand-crafts
    // a Payment with the flag set. This is the only place in `error-showcase`
    // that imports `Client` from xrpl, and it does so on purpose: it exists to
    // prove that the *server* defends against this attack regardless of how
    // the client built the tx.
    log.loading('Crafting a Payment with tfPartialPayment (simulated malicious client)...')
    const xrpl = new Client(XRPL_RPC_URLS[NETWORK])
    await xrpl.connect()
    let blob: string
    try {
      const tx: any = {
        TransactionType: 'Payment',
        Account: mainWallet.address,
        Destination: recipientWallet.address,
        Amount: '1000000',
        Flags: TF_PARTIAL_PAYMENT,
      }
      const prepared = await xrpl.autofill(tx)
      const signed = mainWallet._xrplWallet.sign(prepared)
      blob = signed.tx_blob
    } finally {
      await xrpl.disconnect()
    }

    const store = Store.memory()
    const srv = serverCharge({ recipient: recipientWallet.address, network: NETWORK, store })

    const ch = {
      id: `partial-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '1000000',
        currency: 'XRP',
        recipient: recipientWallet.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
      },
    }
    const partialCred = Credential.from({
      challenge: ch as any,
      payload: { type: 'transaction', blob },
      source: `did:pkh:xrpl:${NETWORK}:${mainWallet.address}`,
    })

    log.loading('Server verifies the malicious credential (must reject)...')
    try {
      await srv.verify({ credential: partialCred as any, request: ch.request })
      log.error('Server unexpectedly accepted a tfPartialPayment credential.')
    } catch (err: any) {
      log.error(err.message.slice(0, 200))
    }

    log.fix('Client signs WITHOUT tfPartialPayment (the standard SDK path)...')
    log.loading('Retrying via the regular charge flow...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: recipientWallet.address,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Standard payment accepted')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 16 ----
  header('DESTINATION_TAG_MISMATCH')
  {
    // The server's challenge requires a specific DestinationTag. The client
    // signs a Payment without it -- the server's verify catches the mismatch
    // before submitting and surfaces a typed SUBMISSION_FAILED ('DestinationTag
    // mismatch ...'). Then we retry with the matching tag and confirm
    // settlement.
    const expectedTag = 1234567

    const store = Store.memory()
    const srv = serverCharge({ recipient: recipientWallet.address, network: NETWORK, store })
    const cli = clientCharge({ wallet: mainWallet, mode: 'pull', network: NETWORK })

    log.loading(`Server expects DestinationTag=${expectedTag} on the inbound Payment...`)
    log.loading('Client builds a credential WITHOUT the tag (the request lies about the schema)...')
    const wrongCh = {
      id: `tag-bad-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '1000000',
        currency: 'XRP',
        recipient: recipientWallet.address,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
      },
    }
    const wrongCredStr = await cli.createCredential({ challenge: wrongCh, context: {} })
    const wrongCred = Credential.deserialize(wrongCredStr)

    try {
      await srv.verify({
        credential: wrongCred as any,
        request: {
          ...wrongCh.request,
          methodDetails: { ...wrongCh.request.methodDetails, destinationTag: expectedTag },
        },
      })
      log.error('Server unexpectedly accepted a Payment that lacked the required tag.')
    } catch (err: any) {
      log.error(err.message.slice(0, 200))
    }

    log.fix(`Client now signs WITH DestinationTag=${expectedTag}...`)
    const okCh = {
      id: `tag-ok-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 300_000).toISOString(),
      request: {
        amount: '1000000',
        currency: 'XRP',
        recipient: recipientWallet.address,
        methodDetails: {
          network: NETWORK,
          reference: crypto.randomUUID(),
          destinationTag: expectedTag,
        },
      },
    }
    const okCredStr = await cli.createCredential({ challenge: okCh, context: {} })
    const okCred = Credential.deserialize(okCredStr)

    log.loading('Retrying with the matching tag...')
    try {
      const receipt = await srv.verify({ credential: okCred as any, request: okCh.request })
      log.success(`Tagged payment accepted (ref: ${receipt.reference})`)
      log.tx(receipt.reference, log.explorerLink(receipt.reference))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message.slice(0, 200)}`)
    }
  }

  log.separator()
  log.box([`All ${total} error cases completed`])
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err}`)
  process.exit(1)
})
