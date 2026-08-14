import { Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async request(params: any) {
      if (params.command === 'ledger_current') {
        return { result: { ledger_current_index: 99_000_000 } }
      }
      return { result: {} }
    }
    // Unused by these tests but referenced by the server module for
    // setup short-circuits.
    async submit() {
      return { result: { engine_result: 'tesSUCCESS', tx_json: { hash: 'X'.repeat(64) } } }
    }
    async submitAndWait() {
      return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'X'.repeat(64) } }
    }
    async autofill(tx: any) {
      return { ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 100_000_000 }
    }
  }
  return { ...actual, Client: FakeClient }
})

const { Wallet } = await import('xrpl')
const { charge: serverCharge } = await import('../../sdk/src/server/Charge.js')

const NETWORK = 'testnet'

function buildCharge(args: {
  payer: InstanceType<typeof Wallet>
  recipient: InstanceType<typeof Wallet>
  amount: string
  tx: any
  challengeMethodDetails?: Record<string, unknown>
  expires?: string
  /** Build a challenge with no `expires` at all, which the server refuses. */
  omitExpires?: boolean
}) {
  const { payer, recipient, amount, tx, challengeMethodDetails = {}, expires, omitExpires } = args
  const signed = payer.sign(tx as any)
  const challenge = {
    id: `meta-${Math.random().toString(36).slice(2)}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    // Every real challenge carries an expiry: mppx sets one by default and the
    // server derives all of its temporal bounds from it. Default it here so
    // fixtures match production, and let a test opt out explicitly.
    ...(omitExpires ? {} : { expires: expires ?? new Date(Date.now() + 300_000).toISOString() }),
    request: {
      amount,
      currency: 'XRP',
      recipient: recipient.classicAddress,
      methodDetails: { network: NETWORK, ...challengeMethodDetails },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { type: 'transaction', blob: signed.tx_blob },
    source: `did:pkh:xrpl:${NETWORK}:${payer.classicAddress}`,
  })
  return { challenge, cred }
}

function basePayment(payer: InstanceType<typeof Wallet>, recipient: string, amount: string) {
  return {
    TransactionType: 'Payment' as const,
    Account: payer.classicAddress,
    Destination: recipient,
    Amount: amount,
    Fee: '12',
    Sequence: 1,
    SigningPubKey: payer.publicKey,
    Flags: 0,
    LastLedgerSequence: 100_000_000,
  }
}

describe('charge server -- DestinationTag / SourceTag / InvoiceID enforcement', () => {
  it('rejects pull-mode credential when DestinationTag in tx does not match challenge', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = { ...basePayment(payer, recipient.classicAddress, '1000000'), DestinationTag: 999 }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      challengeMethodDetails: { destinationTag: 12345 },
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      storeDurability: 'process-local',
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/DestinationTag mismatch/)
  })

  it('rejects pull-mode credential when SourceTag in tx does not match challenge', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = { ...basePayment(payer, recipient.classicAddress, '1000000'), SourceTag: 7 }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      challengeMethodDetails: { sourceTag: 8 },
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      storeDurability: 'process-local',
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/SourceTag mismatch/)
  })

  it('rejects pull-mode credential when challenge expects a tag but tx has none', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = basePayment(payer, recipient.classicAddress, '1000000')
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      challengeMethodDetails: { destinationTag: 12345 },
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      storeDurability: 'process-local',
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/DestinationTag mismatch.*got none/)
  })
})

describe('charge server -- LastLedgerSequence vs challenge.expires enforcement', () => {
  it('rejects a tx whose LastLedgerSequence would let it land past challenge.expires', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    // FakeClient.ledger_current returns 99_000_000. A 30s expiry caps
    // LLS at 99_000_000 + ceil(30/4) = 99_000_008, plus 4 ledgers slack
    // = 99_000_012. The basePayment template uses LLS = 100_000_000,
    // way beyond the cap.
    const tx = {
      ...basePayment(payer, recipient.classicAddress, '1000000'),
      LastLedgerSequence: 100_000_000,
    }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      expires: new Date(Date.now() + 30_000).toISOString(),
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      storeDurability: 'process-local',
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/LastLedgerSequence.*exceeds.*cap/)
  })

  it('accepts a tx whose LastLedgerSequence is within the expires-derived cap', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    // Cap = 99_000_008 (+ 4 slack) = 99_000_012. LLS = 99_000_010 fits.
    const tx = {
      ...basePayment(payer, recipient.classicAddress, '1000000'),
      LastLedgerSequence: 99_000_010,
    }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      expires: new Date(Date.now() + 30_000).toISOString(),
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      storeDurability: 'process-local',
      network: NETWORK,
      // Trim the post-LLS poll loop -- the mock client returns no `tx`
      // entry, so verifyPull would otherwise spin until the default
      // pollTimeout (60 s). We only care that the LLS check itself does
      // not reject; the eventual timeout has its own distinct message.
      pollTimeout: 100,
      pollInterval: 50,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.not.toThrow(/LastLedgerSequence/)
  })

  it('rejects a challenge that carries no expires at all', async () => {
    // `expires` is the sole authenticated temporal statement on a challenge, and
    // the freshness check, the LastLedgerSequence cap and the transaction-age
    // floor all derive from it. Accepting a challenge without one would disable
    // the three together, so a credential without it is refused.
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = {
      ...basePayment(payer, recipient.classicAddress, '1000000'),
      LastLedgerSequence: 100_000_000,
    }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      omitExpires: true,
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      storeDurability: 'process-local',
      network: NETWORK,
      pollTimeout: 100,
      pollInterval: 50,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/carries no expires/)
  })
})
