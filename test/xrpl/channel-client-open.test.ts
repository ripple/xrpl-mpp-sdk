import { Credential } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel as clientChannel } from '../../sdk/src/channel/client/Channel.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const MERCHANT = 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9'

/**
 * The open challenge already states who is to be paid, so a caller should not
 * have to learn the merchant's address through a side channel before it can
 * ask for the resource. What the challenge cannot state is how much to deposit
 * or for how long: those are the payer's risk decisions and come from config.
 *
 * Building the transaction needs a funded account -- its sequence and fee come
 * from the ledger -- so what gets built is asserted in the devnet suite. What
 * is offline, and covered here, is whether to build at all and what to refuse.
 */
function openChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'open-1',
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: '0',
      channelId: '',
      recipient: MERCHANT,
      methodDetails: { network: NETWORK },
      ...overrides,
    },
  }
}

async function openCredential(method: any, challenge: any, context: any = { action: 'open' }) {
  const blob = await method.createCredential({ challenge, context })
  return Credential.deserialize(blob) as any
}

describe('client decides whether to build the open transaction', () => {
  it('lets a pre-built transaction win', async () => {
    // A caller with its own signing arrangement keeps control.
    const wallet = Wallet.generate()
    const method = clientChannel({
      wallet,
      network: NETWORK,
      openChannel: { amount: '5000000', settleDelay: 3600 },
    })

    const cred = await openCredential(method, openChallenge(), {
      action: 'open',
      openTransaction: 'DEADBEEF',
    })

    expect(cred.payload.transaction).toBe('DEADBEEF')
  })

  it('says what is missing when neither a policy nor a transaction is given', async () => {
    const wallet = Wallet.generate()
    const method = clientChannel({ wallet, network: NETWORK })

    await expect(openCredential(method, openChallenge())).rejects.toThrow(
      /needs either `openTransaction`[\s\S]*or an `openChannel` policy/,
    )
  })

  it('refuses an open challenge that names no recipient', async () => {
    // Nothing to open a channel towards, and guessing would send a deposit
    // somewhere the caller never agreed to.
    const wallet = Wallet.generate()
    const method = clientChannel({
      wallet,
      network: NETWORK,
      openChannel: { amount: '5000000', settleDelay: 3600 },
    })

    await expect(openCredential(method, openChallenge({ recipient: undefined }))).rejects.toThrow(
      /no `recipient`/,
    )
  })
})
