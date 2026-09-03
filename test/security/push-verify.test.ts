import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'
import { challengeInvoiceId } from '../../sdk/src/utils/binding.js'
import { storeKeys } from '../../sdk/src/utils/keys.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

/**
 * Push-mode verification had no test coverage at all, which is how five
 * separate defects reached a review: the response-shape regression, the dropped
 * ledger_index guard, the age-floor anchoring flaw, the timeout fall-through and
 * the bogus-hash socket hold. This harness drives `verifyPush` end to end
 * against a scripted node so each of those is pinned.
 *
 * `txResponses` is the queue the fake node answers `tx` from. A `null` entry
 * answers with a txnNotFound error, the way rippled does for a hash it has not
 * seen.
 */
const state: {
  txResponses: (Record<string, unknown> | null)[]
  txCalls: number
  serverInfoSeq: number
  currentLedgerIndex: number
} = { txResponses: [], txCalls: 0, serverInfoSeq: 1_000_020, currentLedgerIndex: 1_000_020 }

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async request(params: any) {
      if (params.command === 'tx') {
        state.txCalls++
        const next = state.txResponses.length > 1 ? state.txResponses.shift() : state.txResponses[0]
        if (next === null || next === undefined) {
          const err: any = new Error('txnNotFound')
          err.data = { error: 'txnNotFound' }
          throw err
        }
        return { result: next }
      }
      if (params.command === 'server_info') {
        return { result: { info: { validated_ledger: { seq: state.serverInfoSeq } } } }
      }
      if (params.command === 'ledger_current') {
        return { result: { ledger_current_index: state.currentLedgerIndex } }
      }
      throw new Error(`unexpected command ${params.command}`)
    }
  }
  return { ...actual, Client: FakeClient }
})

const { charge: serverCharge } = await import('../../sdk/src/server/Charge.js')

const NETWORK = 'testnet'
const TX_HASH = 'AB'.repeat(32)
const keys = storeKeys(NETWORK)

function challengeFor(
  options: { id?: string; expiresInMs?: number; methodDetails?: Record<string, unknown> } = {},
) {
  const id = options.id ?? `ch-${Math.random()}`
  return {
    id,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    expires: new Date(Date.now() + (options.expiresInMs ?? 300_000)).toISOString(),
    request: {
      amount: '1000000',
      currency: 'XRP',
      recipient: RECIPIENT.address,
      methodDetails: { network: NETWORK, ...options.methodDetails },
    },
  }
}

let PAYER: Wallet
let RECIPIENT: Wallet

/** A validated, successful Payment in the nested (api_version 2) shape. */
function nestedOk(challengeId: string, overrides: Record<string, unknown> = {}) {
  return {
    validated: true,
    ledger_index: 1_000_018,
    meta: { TransactionResult: 'tesSUCCESS' },
    tx_json: {
      TransactionType: 'Payment',
      Account: PAYER.address,
      Destination: RECIPIENT.address,
      Amount: '1000000',
      InvoiceID: challengeInvoiceId(challengeId),
      SourceTag: 0,
    },
    ...overrides,
  }
}

/** The same payment in the flattened (api_version 1) shape rippled also emits. */
function flatOk(challengeId: string, overrides: Record<string, unknown> = {}) {
  return {
    validated: true,
    ledger_index: 1_000_018,
    meta: { TransactionResult: 'tesSUCCESS' },
    TransactionType: 'Payment',
    Account: PAYER.address,
    Destination: RECIPIENT.address,
    Amount: '1000000',
    InvoiceID: challengeInvoiceId(challengeId),
    SourceTag: 0,
    ...overrides,
  }
}

function pushCredential(challenge: ReturnType<typeof challengeFor>) {
  return Credential.from({
    challenge: challenge as any,
    payload: { type: 'hash', hash: TX_HASH },
    source: `did:pkh:xrpl:${NETWORK}:${PAYER.address}`,
  })
}

function method(store: ReturnType<typeof Store.memory>, overrides: Record<string, unknown> = {}) {
  return serverCharge({
    recipient: RECIPIENT.address,
    network: NETWORK,
    store,
    storeDurability: 'process-local',
    pollTimeout: 200,
    pollInterval: 20,
    ...overrides,
  })
}

describe('push-mode verification', () => {
  beforeEach(() => {
    PAYER = Wallet.generate()
    RECIPIENT = Wallet.generate()
    state.txResponses = []
    state.txCalls = 0
    state.serverInfoSeq = 1_000_020
    state.currentLedgerIndex = 1_000_020
  })

  it('accepts a validated payment in the nested tx_json shape', async () => {
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [nestedOk(challenge.id)]

    const receipt = await method(store).verify({
      credential: pushCredential(challenge) as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('accepts a validated payment in the flattened tx shape', async () => {
    // rippled's api_version 1 puts the Payment fields on the result root. The
    // refactor started extracting them from the already strip-parsed response,
    // which discards every Payment field, so this shape could never verify.
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [flatOk(challenge.id)]

    const receipt = await method(store).verify({
      credential: pushCredential(challenge) as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('accepts an operator invoiceId written in lowercase', async () => {
    // The route schema accepts hex in either case, and rippled always reports
    // Hash256 fields uppercase. Comparing the two literally refused a payment
    // bound exactly as the challenge asked, so the compare is canonical.
    const store = Store.memory()
    const invoiceId = 'CD'.repeat(32)
    const challenge = challengeFor({ methodDetails: { invoiceId: invoiceId.toLowerCase() } })
    state.txResponses = [
      nestedOk(challenge.id, {
        tx_json: { ...nestedOk(challenge.id).tx_json, InvoiceID: invoiceId },
      }),
    ]

    const receipt = await method(store).verify({
      credential: pushCredential(challenge) as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('still rejects an InvoiceID that differs by more than case', async () => {
    // The canonical compare must not become a blanket tolerance: binding is
    // what stops an unrelated payment from satisfying this challenge.
    const store = Store.memory()
    const challenge = challengeFor({ methodDetails: { invoiceId: 'CD'.repeat(32) } })
    state.txResponses = [
      nestedOk(challenge.id, {
        tx_json: { ...nestedOk(challenge.id).tx_json, InvoiceID: 'EF'.repeat(32) },
      }),
    ]

    await expect(
      method(store).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow(/InvoiceID mismatch/)
  })

  it('rejects a response that omits ledger_index', async () => {
    // ledger_index is what the transaction-age floor is computed from. Accepting
    // a response without it silently disables that floor, so an arbitrarily old
    // payment becomes acceptable proof.
    const store = Store.memory()
    const challenge = challengeFor()
    const { ledger_index: _dropped, ...noIndex } = nestedOk(challenge.id)
    state.txResponses = [noIndex]

    await expect(
      method(store).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow(/ledger_index/)
  })

  it('rejects a payment that settled before the challenge window', async () => {
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [nestedOk(challenge.id, { ledger_index: 900_000 })]

    await expect(
      method(store).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow(/predates/)
  })

  it('accepts an immediate payment even on a long expires window', async () => {
    // The age floor must not be derived by subtracting two independently
    // configured values: a 30-minute expires window with the default 5-minute
    // assumed lifetime put the issuance floor 25 minutes in the future, so a
    // payment made immediately was rejected as predating its own challenge.
    const store = Store.memory()
    const challenge = challengeFor({ expiresInMs: 30 * 60_000 })
    state.txResponses = [nestedOk(challenge.id)]

    const receipt = await method(store).verify({
      credential: pushCredential(challenge) as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('gives up quickly on a hash the node has never seen', async () => {
    // A bogus hash used to fail on the first lookup. Polling it for the whole
    // pollTimeout holds a socket and a request slot per attempt, which is free
    // amplification for an unauthenticated caller.
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [null]

    await expect(
      method(store, { pollTimeout: 2_000, pollInterval: 20 }).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow()

    // One lookup, not one per poll interval.
    expect(state.txCalls).toBeLessThanOrEqual(3)
  })

  it('waits for confirmation depth rather than failing', async () => {
    const store = Store.memory()
    const challenge = challengeFor()
    // Validated at depth 1, then the ledger advances enough for depth 3.
    state.serverInfoSeq = 1_000_018
    state.txResponses = [nestedOk(challenge.id)]
    setTimeout(() => {
      state.serverInfoSeq = 1_000_020
    }, 40)

    const receipt = await method(store, {
      minLedgerConfirmations: 3,
      pollTimeout: 2_000,
    }).verify({ credential: pushCredential(challenge) as any, request: challenge.request })
    expect(receipt.status).toBe('success')
  })

  it('rejects an unvalidated response', async () => {
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [nestedOk(challenge.id, { validated: false })]

    await expect(
      method(store).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow()
  })

  it('rejects a non-Payment transaction presented as proof', async () => {
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [
      nestedOk(challenge.id, {
        tx_json: {
          TransactionType: 'EscrowCreate',
          Account: PAYER.address,
          Destination: RECIPIENT.address,
          Amount: '1000000',
          InvoiceID: challengeInvoiceId(challenge.id),
          SourceTag: 0,
        },
      }),
    ]

    await expect(
      method(store).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow(/Expected a Payment transaction/)
  })

  it('rejects an unbound push payment by default', async () => {
    const store = Store.memory()
    const challenge = challengeFor()
    const { InvoiceID: _none, ...unbound } = nestedOk(challenge.id).tx_json
    state.txResponses = [nestedOk(challenge.id, { tx_json: unbound })]

    await expect(
      method(store).verify({
        credential: pushCredential(challenge) as any,
        request: challenge.request,
      }),
    ).rejects.toThrow(/not bound to this challenge/)
  })

  it('writes a bounded retention on the accepted claim', async () => {
    // The retention wiring had no end-to-end assertion: reverting
    // replayRetentionFor to retain-forever left the whole suite green.
    const store = Store.memory()
    const challenge = challengeFor()
    state.txResponses = [nestedOk(challenge.id)]

    await method(store).verify({
      credential: pushCredential(challenge) as any,
      request: challenge.request,
    })

    for (const key of [keys.challenge(challenge.id), keys.tx(TX_HASH)]) {
      const record = (await store.get(key)) as { expiresAt?: number } | null
      expect(record, `${key} should exist`).not.toBeNull()
      expect(record?.expiresAt, `${key} should carry an expiry`).toBeTypeOf('number')
      expect(record?.expiresAt).toBeGreaterThan(Date.now())
    }
  })
})
