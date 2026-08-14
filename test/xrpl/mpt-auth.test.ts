import { describe, expect, it, vi } from 'vitest'
import { Wallet } from 'xrpl'
import { ensureMPTHolding } from '../../sdk/src/utils/mpt.js'

const ISSUANCE_ID = '00000000A0CDEF0123456789ABCDEF0123456789ABCDEF01'
const MPT = { mpt_issuance_id: ISSUANCE_ID }

const LSF_ISSUANCE_REQUIRE_AUTH = 0x00000004
const LSF_HOLDING_AUTHORIZED = 0x00000002

function mockClient(handlers: {
  accountObjects?: () => any
  accountInfo?: () => any
  serverState?: () => any
  ledgerEntry?: (params: any) => any
  submitAndWait?: (tx: any) => any
}): any {
  return {
    request: vi.fn(async (params: any) => {
      switch (params.command) {
        case 'account_objects':
          return handlers.accountObjects?.() ?? { result: { account_objects: [] } }
        case 'account_info':
          return (
            handlers.accountInfo?.() ?? {
              result: { account_data: { Balance: '5000000', OwnerCount: 0, Flags: 0 } },
            }
          )
        case 'server_state':
          return (
            handlers.serverState?.() ?? {
              result: {
                state: { validated_ledger: { reserve_base: '1000000', reserve_inc: '200000' } },
              },
            }
          )
        case 'ledger_entry':
          return handlers.ledgerEntry?.(params) ?? { result: { node: { Flags: 0 } } }
        default:
          throw new Error(`unmocked command: ${params.command}`)
      }
    }),
    submitAndWait: vi.fn(
      async (tx: any) =>
        handlers.submitAndWait?.(tx) ?? {
          result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'h' },
        },
    ),
  }
}

describe('ensureMPTHolding -- auth and reserve checks', () => {
  it('short-circuits when account already holds the MPT (no allowlist)', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({
        result: { account_objects: [{ MPTokenIssuanceID: ISSUANCE_ID, Flags: 0 }] },
      }),
    })
    await ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true })
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('short-circuits when allowlisted issuance and holder already authorized', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({
        result: {
          account_objects: [{ MPTokenIssuanceID: ISSUANCE_ID, Flags: LSF_HOLDING_AUTHORIZED }],
        },
      }),
      ledgerEntry: () => ({ result: { node: { Flags: LSF_ISSUANCE_REQUIRE_AUTH } } }),
    })
    await ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true })
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('throws MPT_NOT_AUTHORIZED when autoMPTAuthorize=false and no holding exists', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({ result: { account_objects: [] } }),
    })
    await expect(
      ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: false }),
    ).rejects.toThrow(/MPT_NOT_AUTHORIZED/)
  })

  it('throws when MPT issuance does not exist on chain', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({ result: { account_objects: [] } }),
      ledgerEntry: () => {
        const err: any = new Error('entryNotFound')
        err.data = { error: 'entryNotFound' }
        throw err
      },
    })
    await expect(
      ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true }),
    ).rejects.toThrow(/MPT_NOT_AUTHORIZED.*does not exist/)
  })

  it('throws INSUFFICIENT_RESERVE when account cannot cover one more owner object', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({ result: { account_objects: [] } }),
      accountInfo: () => ({
        result: { account_data: { Balance: '1000000', OwnerCount: 0 } },
      }),
      ledgerEntry: () => ({ result: { node: { Flags: 0 } } }),
    })
    await expect(
      ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true }),
    ).rejects.toThrow(/INSUFFICIENT_RESERVE.*MPTokenAuthorize/)
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })

  it('submits MPTokenAuthorize when issuance is open and reserves OK', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({ result: { account_objects: [] } }),
    })
    await ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true })
    expect(client.submitAndWait).toHaveBeenCalledTimes(1)
    const tx = client.submitAndWait.mock.calls[0][0]
    expect(tx.TransactionType).toBe('MPTokenAuthorize')
    expect(tx.MPTokenIssuanceID).toBe(ISSUANCE_ID)
  })

  it('after submit, surfaces MPT_NOT_AUTHORIZED if issuance has lsfMPTRequireAuth', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({ result: { account_objects: [] } }),
      ledgerEntry: () => ({ result: { node: { Flags: LSF_ISSUANCE_REQUIRE_AUTH } } }),
    })
    await expect(
      ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true }),
    ).rejects.toThrow(/MPT_NOT_AUTHORIZED.*lsfMPTRequireAuth/)
    expect(client.submitAndWait).toHaveBeenCalledTimes(1)
  })

  it('throws MPT_NOT_AUTHORIZED when allowlisted holder created but issuer has not signed', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountObjects: () => ({
        // Holder side exists but lsfMPTAuthorized is NOT set yet.
        result: { account_objects: [{ MPTokenIssuanceID: ISSUANCE_ID, Flags: 0 }] },
      }),
      ledgerEntry: () => ({ result: { node: { Flags: LSF_ISSUANCE_REQUIRE_AUTH } } }),
    })
    await expect(
      ensureMPTHolding({ client, wallet, mpt: MPT, autoMPTAuthorize: true }),
    ).rejects.toThrow(/MPT_NOT_AUTHORIZED.*has not yet authorised/)
    expect(client.submitAndWait).not.toHaveBeenCalled()
  })
})
