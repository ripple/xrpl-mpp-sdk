import { describe, expect, it, vi } from 'vitest'
import { hashes, unixTimeToRippleTime, Wallet } from 'xrpl'
import {
  cancelEscrow,
  createEscrow,
  finishEscrow,
  generatePreimageCondition,
  getEscrow,
  listEscrows,
} from '../../sdk/src/utils/escrow.js'

/** Build a mock xrpl.Client wired to handler functions per RPC command. */
function mockClient(handlers: {
  accountInfo?: () => any
  serverState?: () => any
  ledgerEntry?: (params: any) => any
  /** Close time of the latest validated ledger, in ripple seconds. */
  ledgerCloseTime?: () => number
  accountObjects?: (params: any) => any
  submitAndWait?: (tx: any) => any
}): any {
  return {
    request: vi.fn(async (params: any) => {
      switch (params.command) {
        case 'account_info':
          return (
            handlers.accountInfo?.() ?? {
              result: { account_data: { Balance: '50000000', OwnerCount: 0 } },
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
        // The escrow pre-flights judge FinishAfter and CancelAfter against the
        // ledger's own clock, so a mock has to supply one. Defaults to now.
        case 'ledger':
          return {
            result: {
              ledger: {
                close_time: handlers.ledgerCloseTime?.() ?? unixTimeToRippleTime(Date.now()),
              },
            },
          }
        case 'ledger_entry':
          return handlers.ledgerEntry?.(params) ?? { result: { node: null } }
        case 'account_objects':
          return handlers.accountObjects?.(params) ?? { result: { account_objects: [] } }
        default:
          throw new Error(`unmocked command: ${params.command}`)
      }
    }),
    submitAndWait: vi.fn(
      async (tx: any) =>
        handlers.submitAndWait?.(tx) ?? {
          result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'h', tx_json: tx },
        },
    ),
  }
}

const FUTURE = Date.now() + 60 * 60 * 1000 // +1h
const FAR_FUTURE = Date.now() + 2 * 60 * 60 * 1000 // +2h

/** A throwaway but well-formed XRPL classic address for tests. */
const OWNER_ADDR = Wallet.generate().classicAddress

describe('generatePreimageCondition', () => {
  it('returns a fresh PREIMAGE-SHA-256 condition + fulfillment pair', () => {
    const a = generatePreimageCondition()
    const b = generatePreimageCondition()
    expect(a.condition).toMatch(/^A0258020[0-9A-F]{64}810120$/)
    expect(a.fulfillment).toMatch(/^A0228020[0-9A-F]{64}$/)
    expect(a.condition).not.toBe(b.condition)
    expect(a.fulfillment).not.toBe(b.fulfillment)
  })
})

describe('createEscrow -- validation', () => {
  it('rejects when neither finishAfter nor condition is set', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({})
    await expect(
      createEscrow(client, wallet, { destination: 'rDest', amount: '1000000' }),
    ).rejects.toThrow(/INVALID_AMOUNT.*finishAfter.*condition/)
  })

  it('rejects when finishAfter >= cancelAfter', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({})
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: '1000000',
        finishAfter: new Date(FAR_FUTURE),
        cancelAfter: new Date(FUTURE),
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*finishAfter.*strictly less than.*cancelAfter/)
  })

  it('rejects a token (IOU/MPT) escrow created without cancelAfter', async () => {
    // XLS-85: token escrows must always carry an expiration (CancelAfter).
    // Without it the token locks on create but EscrowFinish is rejected
    // on-chain with tecNO_PERMISSION. We surface that as a typed error
    // upfront instead of letting the holder fund an unfinishable escrow.
    const wallet = Wallet.generate()
    const client = mockClient({})
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: { mpt_issuance_id: '00'.repeat(24), value: '500' },
        finishAfter: new Date(FUTURE),
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*token escrow.*cancelAfter/)

    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: { currency: 'USD', issuer: OWNER_ADDR, value: '10' },
        finishAfter: new Date(FUTURE),
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*token escrow.*cancelAfter/)
  })

  it('rejects past timestamps', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({})
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: '1000000',
        finishAfter: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*finishAfter.*future/)
  })

  it('rejects amount of 0 drops', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({})
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: '0',
        finishAfter: new Date(FUTURE),
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*amount.*> 0 drops/)
  })

  it('rejects malformed condition (non-hex)', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({})
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: '1000000',
        finishAfter: new Date(FUTURE),
        condition: 'not-hex!',
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*condition.*hex/)
  })

  it('runs reserve preflight and surfaces INSUFFICIENT_RESERVE', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      accountInfo: () => ({
        result: { account_data: { Balance: '1500000', OwnerCount: 0 } }, // 1.5 XRP
      }),
    })
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: '1000000', // 1 XRP locked + base reserve 1 + 0.2 inc + fee > 1.5 -> fail
        finishAfter: new Date(FUTURE),
      }),
    ).rejects.toThrow(/INSUFFICIENT_RESERVE.*EscrowCreate/)
  })

  it('submits with FinishAfter + CancelAfter and returns hash + sequence + escrowId', async () => {
    const wallet = Wallet.generate()
    let captured: any
    const client = mockClient({
      submitAndWait: (tx) => {
        captured = tx
        return {
          result: {
            meta: { TransactionResult: 'tesSUCCESS' },
            hash: 'TX_HASH',
            tx_json: { ...tx, Sequence: 42 },
          },
        }
      },
    })
    const result = await createEscrow(client, wallet, {
      destination: 'rDest',
      amount: '2000000',
      finishAfter: new Date(FUTURE),
      cancelAfter: new Date(FAR_FUTURE),
      destinationTag: 7,
    })
    expect(result.hash).toBe('TX_HASH')
    expect(result.sequence).toBe(42)
    expect(result.escrowId).toBe(hashes.hashEscrow(wallet.classicAddress, 42))
    expect(captured.TransactionType).toBe('EscrowCreate')
    expect(captured.Destination).toBe('rDest')
    expect(captured.Amount).toBe('2000000')
    expect(captured.FinishAfter).toBe(unixTimeToRippleTime(new Date(FUTURE).getTime()))
    expect(captured.CancelAfter).toBe(unixTimeToRippleTime(new Date(FAR_FUTURE).getTime()))
    expect(captured.DestinationTag).toBe(7)
  })

  it('throws ESCROW_FAILED when the ledger rejects the submit', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      submitAndWait: () => ({
        result: { meta: { TransactionResult: 'tecINSUFFICIENT_RESERVE' }, hash: 'h' },
      }),
    })
    await expect(
      createEscrow(client, wallet, {
        destination: 'rDest',
        amount: '1000000',
        finishAfter: new Date(FUTURE),
      }),
    ).rejects.toThrow(/ESCROW_FAILED.*tecINSUFFICIENT_RESERVE/)
  })
})

describe('finishEscrow', () => {
  it('throws ESCROW_NOT_FOUND when no escrow exists at (owner, sequence)', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      ledgerEntry: () => ({ result: { node: null } }),
    })
    await expect(finishEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_NOT_FOUND/,
    )
  })

  it('throws ESCROW_NOT_READY when FinishAfter has not elapsed', async () => {
    const wallet = Wallet.generate()
    const finishAfter = unixTimeToRippleTime(Date.now() + 60_000)
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            FinishAfter: finishAfter,
          },
        },
      }),
    })
    await expect(finishEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_NOT_READY.*FinishAfter/,
    )
  })

  it('throws ESCROW_INVALID_FULFILLMENT when condition required but not provided', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            Condition: 'A025'.padEnd(72, '0'),
          },
        },
      }),
    })
    await expect(finishEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_INVALID_FULFILLMENT.*condition.*fulfillment/,
    )
  })

  it('throws ESCROW_INVALID_FULFILLMENT when provided condition does not match on-chain one', async () => {
    const wallet = Wallet.generate()
    const onChain = 'A025802000'.padEnd(72, '0')
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            Condition: onChain,
          },
        },
      }),
    })
    await expect(
      finishEscrow(client, wallet, {
        owner: OWNER_ADDR,
        sequence: 1,
        condition: 'A025802000'.padEnd(72, '1'),
        fulfillment: 'A0228020'.padEnd(72, '1'),
      }),
    ).rejects.toThrow(/ESCROW_INVALID_FULFILLMENT.*does not match.*on-chain/)
  })

  it('submits EscrowFinish with Owner + OfferSequence when escrow is ready', async () => {
    const wallet = Wallet.generate()
    let captured: any
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            FinishAfter: unixTimeToRippleTime(Date.now() - 60_000),
          },
        },
      }),
      submitAndWait: (tx) => {
        captured = tx
        return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'FINISH_H' } }
      },
    })
    const out = await finishEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 7 })
    expect(out.hash).toBe('FINISH_H')
    expect(captured.TransactionType).toBe('EscrowFinish')
    expect(captured.Owner).toBe(OWNER_ADDR)
    expect(captured.OfferSequence).toBe(7)
    expect(captured.Condition).toBeUndefined()
    expect(captured.Fulfillment).toBeUndefined()
  })

  it('submits with Condition + Fulfillment uppercased when both match', async () => {
    const wallet = Wallet.generate()
    const { condition, fulfillment } = generatePreimageCondition()
    let captured: any
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            Condition: condition,
          },
        },
      }),
      submitAndWait: (tx) => {
        captured = tx
        return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'h' } }
      },
    })
    await finishEscrow(client, wallet, {
      owner: OWNER_ADDR,
      sequence: 1,
      condition: condition.toLowerCase(),
      fulfillment: fulfillment.toLowerCase(),
    })
    expect(captured.Condition).toBe(condition.toUpperCase())
    expect(captured.Fulfillment).toBe(fulfillment.toUpperCase())
  })

  it('judges FinishAfter on the ledger clock, not the local one', async () => {
    // The case CI hit: the ledger has closed past FinishAfter while the local
    // clock is still a moment short. Gating on Date.now() refused a finish the
    // ledger would have accepted.
    const wallet = Wallet.generate()
    const finishAfter = unixTimeToRippleTime(Date.now() + 2_000)
    const client = mockClient({
      ledgerCloseTime: () => finishAfter + 4,
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: Wallet.generate().classicAddress,
            Amount: '5000000',
            FinishAfter: finishAfter,
          },
        },
      }),
      submitAndWait: () => ({
        result: { hash: 'F'.repeat(64), meta: { TransactionResult: 'tesSUCCESS' } },
      }),
    })

    await expect(
      finishEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 }),
    ).resolves.toMatchObject({ hash: 'F'.repeat(64) })
  })

  it('refuses while the ledger clock is still short, even if the local clock has passed', async () => {
    // The inverse, which the local-clock version let through: the SDK submitted
    // and the ledger answered tecNO_PERMISSION.
    const wallet = Wallet.generate()
    const finishAfter = unixTimeToRippleTime(Date.now() - 2_000)
    const client = mockClient({
      ledgerCloseTime: () => finishAfter - 4,
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: Wallet.generate().classicAddress,
            Amount: '5000000',
            FinishAfter: finishAfter,
          },
        },
      }),
    })

    await expect(finishEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_NOT_READY/,
    )
  })
})

describe('cancelEscrow', () => {
  it('throws ESCROW_NOT_FOUND when no escrow exists', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      ledgerEntry: () => ({ result: { node: null } }),
    })
    await expect(cancelEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_NOT_FOUND/,
    )
  })

  it('throws ESCROW_NOT_READY when escrow has no CancelAfter', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            FinishAfter: unixTimeToRippleTime(Date.now() - 60_000),
          },
        },
      }),
    })
    await expect(cancelEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_NOT_READY.*no CancelAfter.*never be cancelled/,
    )
  })

  it('throws ESCROW_NOT_READY when CancelAfter has not elapsed', async () => {
    const wallet = Wallet.generate()
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            CancelAfter: unixTimeToRippleTime(Date.now() + 60_000),
          },
        },
      }),
    })
    await expect(cancelEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 1 })).rejects.toThrow(
      /ESCROW_NOT_READY.*CancelAfter/,
    )
  })

  it('submits EscrowCancel when CancelAfter has elapsed', async () => {
    const wallet = Wallet.generate()
    let captured: any
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            CancelAfter: unixTimeToRippleTime(Date.now() - 60_000),
          },
        },
      }),
      submitAndWait: (tx) => {
        captured = tx
        return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'CANCEL_H' } }
      },
    })
    const out = await cancelEscrow(client, wallet, { owner: OWNER_ADDR, sequence: 5 })
    expect(out.hash).toBe('CANCEL_H')
    expect(captured.TransactionType).toBe('EscrowCancel')
    expect(captured.Owner).toBe(OWNER_ADDR)
    expect(captured.OfferSequence).toBe(5)
  })
})

describe('getEscrow / listEscrows', () => {
  it('getEscrow returns null when ledger reports entryNotFound', async () => {
    const client = mockClient({
      ledgerEntry: () => {
        const err: any = new Error('entryNotFound')
        err.data = { error: 'entryNotFound' }
        throw err
      },
    })
    expect(await getEscrow(client, { owner: OWNER_ADDR, sequence: 1 })).toBeNull()
  })

  it('getEscrow surfaces FinishAfter / CancelAfter as JS Dates', async () => {
    const finishAt = Date.now() + 60_000
    const cancelAt = Date.now() + 120_000
    const client = mockClient({
      ledgerEntry: () => ({
        result: {
          node: {
            Account: OWNER_ADDR,
            Destination: 'rDest',
            Amount: '1000000',
            FinishAfter: unixTimeToRippleTime(finishAt),
            CancelAfter: unixTimeToRippleTime(cancelAt),
            DestinationTag: 9,
          },
        },
      }),
    })
    const info = await getEscrow(client, { owner: OWNER_ADDR, sequence: 3 })
    expect(info).not.toBeNull()
    expect(info!.owner).toBe(OWNER_ADDR)
    expect(info!.sequence).toBe(3)
    expect(info!.destination).toBe('rDest')
    expect(info!.amount).toBe('1000000')
    expect(info!.finishAfter).toBeInstanceOf(Date)
    expect(info!.cancelAfter).toBeInstanceOf(Date)
    // Round-trip through ripple time loses sub-second resolution.
    expect(info!.finishAfter!.getTime()).toBeCloseTo(finishAt, -3)
    expect(info!.destinationTag).toBe(9)
    expect(info!.escrowId).toBe(hashes.hashEscrow(OWNER_ADDR, 3))
  })

  it('listEscrows returns [] when account is unfunded', async () => {
    const client = mockClient({
      accountObjects: () => {
        const err: any = new Error('actNotFound')
        err.data = { error: 'actNotFound' }
        throw err
      },
    })
    expect(await listEscrows(client, 'rGone')).toEqual([])
  })

  it('listEscrows reads OfferSequence from account_objects entries', async () => {
    const client = mockClient({
      accountObjects: () => ({
        result: {
          account_objects: [
            {
              LedgerEntryType: 'Escrow',
              Account: OWNER_ADDR,
              Destination: 'rDest',
              Amount: '1000000',
              OfferSequence: 11,
              FinishAfter: unixTimeToRippleTime(Date.now() + 60_000),
            },
            {
              LedgerEntryType: 'Escrow',
              Account: OWNER_ADDR,
              Destination: 'rDest',
              Amount: '2000000',
              OfferSequence: 12,
            },
          ],
        },
      }),
    })
    const list = await listEscrows(client, OWNER_ADDR)
    expect(list).toHaveLength(2)
    expect(list[0].sequence).toBe(11)
    expect(list[1].sequence).toBe(12)
    expect(list[1].escrowId).toBe(hashes.hashEscrow(OWNER_ADDR, 12))
  })
})

describe('createEscrow -- SourceTag attribution', () => {
  it('stamps the default MPP SourceTag when none is provided', async () => {
    const wallet = Wallet.generate()
    let captured: any
    const client = mockClient({
      submitAndWait: (tx) => {
        captured = tx
        return {
          result: {
            meta: { TransactionResult: 'tesSUCCESS' },
            hash: 'H',
            tx_json: { ...tx, Sequence: 1 },
          },
        }
      },
    })
    await createEscrow(client, wallet, {
      destination: 'rDest',
      amount: '2000000',
      finishAfter: new Date(FUTURE),
    })
    expect(captured.SourceTag).toBe(593184257)
  })

  it('lets an explicit sourceTag override the default', async () => {
    const wallet = Wallet.generate()
    let captured: any
    const client = mockClient({
      submitAndWait: (tx) => {
        captured = tx
        return {
          result: {
            meta: { TransactionResult: 'tesSUCCESS' },
            hash: 'H',
            tx_json: { ...tx, Sequence: 1 },
          },
        }
      },
    })
    await createEscrow(client, wallet, {
      destination: 'rDest',
      amount: '2000000',
      finishAfter: new Date(FUTURE),
      sourceTag: 7,
    })
    expect(captured.SourceTag).toBe(7)
  })
})
