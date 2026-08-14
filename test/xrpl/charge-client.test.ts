import { Credential } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'

// Mock xrpl Client used inside the client charge flow. We override the module
// at vi.mock() time so the charge factory loads the mocked Client when it
// imports xrpl.
//
// The mocked Client supports connect(), disconnect(), autofill() (no-op),
// submitAndWait() (returns a fake hash), submit(), and request() (returns
// stubbed account_info / server_state).
const fakeHash = 'C'.repeat(64)

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async autofill(tx: any) {
      return { ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 100_000_000 }
    }
    async submit(_blob: string) {
      return { result: { engine_result: 'tesSUCCESS', tx_json: { hash: fakeHash } } }
    }
    async submitAndWait(_tx: any, _opts: any) {
      return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: fakeHash } }
    }
    async request(params: any) {
      if (params.command === 'account_info') {
        return {
          result: { account_data: { Balance: '50000000', OwnerCount: 0, Flags: 0x00800000 } },
        }
      }
      if (params.command === 'server_state') {
        return {
          result: {
            state: { validated_ledger: { reserve_base: '1000000', reserve_inc: '200000' } },
          },
        }
      }
      if (params.command === 'ledger_current') {
        return { result: { ledger_current_index: 50_000_000 } }
      }
      return { result: {} }
    }
  }
  return {
    ...actual,
    Client: FakeClient,
  }
})

const { charge } = await import('../../sdk/src/client/Charge.js')
const { Wallet, decode } = await import('xrpl')

describe('charge client createCredential() -- pull mode happy path', () => {
  it('produces a credential whose blob decodes to the expected Payment fields', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: true,
      network: 'devnet',
    })

    const challenge = {
      id: 'mock-1',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: '500000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const, destinationTag: 42 },
      },
    }

    const blob = await method.createCredential({ challenge: challenge as any } as any)
    const cred = Credential.deserialize(blob)
    expect(cred.source).toBe(`did:pkh:xrpl:devnet:${payer.classicAddress}`)
    const payload = cred.payload as { type: 'transaction'; blob: string }
    expect(payload.type).toBe('transaction')
    const decoded = decode(payload.blob) as any
    expect(decoded.TransactionType).toBe('Payment')
    expect(decoded.Account).toBe(payer.classicAddress)
    expect(decoded.Destination).toBe(recipient.classicAddress)
    expect(decoded.Amount).toBe('500000')
    expect(decoded.DestinationTag).toBe(42)
  })

  it('returns push-mode credential when mode override = push', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: false,
      network: 'devnet',
    })

    const challenge = {
      id: 'mock-2',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: '100000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    const blob = await method.createCredential({
      challenge: challenge as any,
      context: { mode: 'push' },
    } as any)
    const cred = Credential.deserialize(blob)
    const payload = cred.payload as { type: 'hash'; hash: string }
    expect(payload.type).toBe('hash')
    // Hash is computed from the signed blob by xrpl.js, not the mock submit response.
    expect(payload.hash).toMatch(/^[0-9A-F]{64}$/)
  })

  it('throws when seed is missing', async () => {
    expect(() => charge({} as any)).toThrow(/seed is required/)
  })

  it('caps LastLedgerSequence to challenge.expires when set', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: false,
      network: 'devnet',
    })

    // 30s window vs FakeClient autofill default of LastLedgerSequence
    // 100_000_000 (current = 50_000_000). The cap should land at
    // ledger_current + ceil(30000 / 4000) = 50_000_008, well below the
    // autofill default.
    const expires = new Date(Date.now() + 30_000).toISOString()

    const challenge = {
      id: 'mock-lls-cap',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires,
      request: {
        amount: '500000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    const blob = await method.createCredential({ challenge: challenge as any } as any)
    const cred = Credential.deserialize(blob)
    const payload = cred.payload as { type: 'transaction'; blob: string }
    const decoded = decode(payload.blob) as { LastLedgerSequence: number }
    expect(decoded.LastLedgerSequence).toBeLessThanOrEqual(50_000_010)
    // Sanity: still within a sensible range above ledger_current.
    expect(decoded.LastLedgerSequence).toBeGreaterThan(50_000_000)
  })

  it('keeps autofill default when challenge.expires is absent', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: false,
      network: 'devnet',
    })

    const challenge = {
      id: 'mock-lls-no-expires',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      request: {
        amount: '500000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    const blob = await method.createCredential({ challenge: challenge as any } as any)
    const cred = Credential.deserialize(blob)
    const payload = cred.payload as { type: 'transaction'; blob: string }
    const decoded = decode(payload.blob) as { LastLedgerSequence: number }
    // Falls back to the autofill default exposed by the FakeClient.
    expect(decoded.LastLedgerSequence).toBe(100_000_000)
  })

  it('rejects challenge.expires that leaves less than one ledger interval', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: false,
      network: 'devnet',
    })

    const challenge = {
      id: 'mock-lls-too-tight',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      expires: new Date(Date.now() + 1_000).toISOString(), // < 4s ledger interval
      request: {
        amount: '500000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    await expect(method.createCredential({ challenge: challenge as any } as any)).rejects.toThrow(
      /SUBMISSION_FAILED.*less than one ledger/,
    )
  })
})

// mpp.dev, Protocol overview, Security considerations, Amount verification:
// "Clients must verify before authorizing payment: (1) requested amount is
// reasonable, (2) recipient/address is expected, (3) currency/asset is as
// expected." These guardrails let the SDK fail closed on a challenge whose
// terms fall outside client-configured bounds, before signing anything.
describe('charge client -- authorization guardrails (mpp.dev Amount verification)', () => {
  const payer = Wallet.generate()
  const goodRecipient = Wallet.generate().classicAddress
  const otherRecipient = Wallet.generate().classicAddress

  function makeChallenge(
    overrides: { amount?: string; currency?: string; recipient?: string } = {},
  ) {
    return {
      id: 'guard-1',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: overrides.amount ?? '500000',
        currency: overrides.currency ?? 'XRP',
        recipient: overrides.recipient ?? goodRecipient,
        methodDetails: { network: 'devnet' as const },
      },
    }
  }

  it('rejects a challenge whose recipient is not the expectedRecipient', async () => {
    const method = charge({
      seed: payer.seed!,
      network: 'devnet',
      preflight: false,
      expectedRecipient: goodRecipient,
    })
    await expect(
      method.createCredential({
        challenge: makeChallenge({ recipient: otherRecipient }) as any,
      } as any),
    ).rejects.toThrow(/CHALLENGE_REJECTED.*recipient/)
  })

  it('accepts a challenge whose recipient is in the expectedRecipient allowlist', async () => {
    const method = charge({
      seed: payer.seed!,
      network: 'devnet',
      preflight: false,
      expectedRecipient: [otherRecipient, goodRecipient],
    })
    const blob = await method.createCredential({ challenge: makeChallenge() as any } as any)
    expect(blob).toMatch(/^Payment\s+/)
  })

  it('rejects a challenge whose amount exceeds maxAmount', async () => {
    const method = charge({
      seed: payer.seed!,
      network: 'devnet',
      preflight: false,
      maxAmount: '100000',
    })
    await expect(
      method.createCredential({ challenge: makeChallenge({ amount: '500000' }) as any } as any),
    ).rejects.toThrow(/CHALLENGE_REJECTED.*exceeds/)
  })

  it('accepts a challenge whose amount is within maxAmount', async () => {
    const method = charge({
      seed: payer.seed!,
      network: 'devnet',
      preflight: false,
      maxAmount: '500000',
    })
    const blob = await method.createCredential({
      challenge: makeChallenge({ amount: '500000' }) as any,
    } as any)
    expect(blob).toMatch(/^Payment\s+/)
  })

  it('rejects a challenge whose currency is not in allowedCurrencies', async () => {
    const method = charge({
      seed: payer.seed!,
      network: 'devnet',
      preflight: false,
      allowedCurrencies: ['XRP'],
    })
    await expect(
      method.createCredential({
        challenge: makeChallenge({ currency: 'USD.rISSUER' }) as any,
      } as any),
    ).rejects.toThrow(/CHALLENGE_REJECTED.*currency/)
  })

  it('signs normally when no guardrails are configured (backward compatible)', async () => {
    const method = charge({ seed: payer.seed!, network: 'devnet', preflight: false })
    const blob = await method.createCredential({
      challenge: makeChallenge({ recipient: otherRecipient, amount: '999999' }) as any,
    } as any)
    expect(blob).toMatch(/^Payment\s+/)
  })
})

// On-chain attribution: the SDK stamps a default SourceTag (MPP_SOURCE_TAG)
// on the Payment so SDK-originated activity is filterable on-chain. An explicit
// sourceTag from the challenge takes precedence (single 32-bit field).
describe('charge client -- SourceTag attribution', () => {
  const payer = Wallet.generate()
  const recipient = Wallet.generate()

  function challenge(methodDetails: Record<string, unknown> = {}) {
    return {
      id: 'st-1',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: '500000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const, ...methodDetails },
      },
    }
  }

  it('stamps the default MPP SourceTag (593184257) when the challenge has none', async () => {
    const method = charge({ seed: payer.seed!, network: 'devnet', preflight: false })
    const blob = await method.createCredential({ challenge: challenge() as any } as any)
    const tx = decode((Credential.deserialize(blob).payload as { blob: string }).blob) as any
    expect(tx.SourceTag).toBe(593184257)
  })

  it('lets an explicit challenge sourceTag override the default', async () => {
    const method = charge({ seed: payer.seed!, network: 'devnet', preflight: false })
    const blob = await method.createCredential({
      challenge: challenge({ sourceTag: 42 }) as any,
    } as any)
    const tx = decode((Credential.deserialize(blob).payload as { blob: string }).blob) as any
    expect(tx.SourceTag).toBe(42)
  })
})
