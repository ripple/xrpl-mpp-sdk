import { Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { assertLedgerFinality } from '../../sdk/src/utils/ledger-time.js'
import { assertSecureRpcUrl } from '../../sdk/src/utils/transport.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

describe('ledger finality', () => {
  const txHash = 'A'.repeat(64)

  it('accepts a validated transaction at the required depth', () => {
    expect(() =>
      assertLedgerFinality({
        validated: true,
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_000,
        minConfirmations: 1,
        txHash,
      }),
    ).not.toThrow()
  })

  it('rejects a transaction the node has not validated', () => {
    // rippled returns metadata for open-ledger transactions too. Treating that
    // as settlement grants a paid resource against a provisional result.
    expect(() =>
      assertLedgerFinality({
        validated: false,
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_000,
        minConfirmations: 1,
        txHash,
      }),
    ).toThrow('not in a validated ledger')
  })

  it('rejects a missing validated flag', () => {
    expect(() =>
      assertLedgerFinality({
        validated: undefined,
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_000,
        minConfirmations: 1,
        txHash,
      }),
    ).toThrow('not in a validated ledger')
  })

  it('rejects a truthy-but-not-true validated flag', () => {
    // A hostile or buggy node returning "yes" must not pass a loose check.
    expect(() =>
      assertLedgerFinality({
        validated: 'yes',
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_000,
        minConfirmations: 1,
        txHash,
      }),
    ).toThrow('not in a validated ledger')
  })

  it('rejects insufficient confirmation depth', () => {
    expect(() =>
      assertLedgerFinality({
        validated: true,
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_001,
        minConfirmations: 5,
        txHash,
      }),
    ).toThrow('fewer than the 5 required')
  })

  it('accepts once depth is reached', () => {
    expect(() =>
      assertLedgerFinality({
        validated: true,
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_004,
        minConfirmations: 5,
        txHash,
      }),
    ).not.toThrow()
  })

  it('rejects a validated transaction with no ledger index when depth matters', () => {
    expect(() =>
      assertLedgerFinality({
        validated: true,
        txLedgerIndex: undefined,
        validatedLedgerIndex: 1_000_000,
        minConfirmations: 2,
        txHash,
      }),
    ).toThrow('confirmation depth cannot be established')
  })

  it('skips the depth check when disabled but still requires validated', () => {
    expect(() =>
      assertLedgerFinality({
        validated: true,
        txLedgerIndex: undefined,
        validatedLedgerIndex: 0,
        minConfirmations: 0,
        txHash,
      }),
    ).not.toThrow()

    expect(() =>
      assertLedgerFinality({
        validated: false,
        txLedgerIndex: 1_000_000,
        validatedLedgerIndex: 1_000_000,
        minConfirmations: 0,
        txHash,
      }),
    ).toThrow('not in a validated ledger')
  })
})

describe('transport security', () => {
  const secure = { allowInsecureTransport: false, context: 'test' }

  it('accepts wss', () => {
    expect(() =>
      assertSecureRpcUrl({ rpcUrl: 'wss://s.altnet.rippletest.net:51233', ...secure }),
    ).not.toThrow()
  })

  it('accepts https', () => {
    expect(() => assertSecureRpcUrl({ rpcUrl: 'https://example.org', ...secure })).not.toThrow()
  })

  it('rejects plaintext ws to a remote host', () => {
    expect(() => assertSecureRpcUrl({ rpcUrl: 'ws://example.org:51233', ...secure })).toThrow(
      'not encrypted',
    )
  })

  it('rejects plaintext http to a remote host', () => {
    expect(() => assertSecureRpcUrl({ rpcUrl: 'http://example.org', ...secure })).toThrow(
      'not encrypted',
    )
  })

  it('allows plaintext to loopback without an opt-out', () => {
    // A local rippled has no transit to protect, and requiring the flag here
    // would push people to set it globally.
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() => assertSecureRpcUrl({ rpcUrl: `ws://${host}:6006`, ...secure })).not.toThrow()
    }
  })

  it('allows plaintext when explicitly acknowledged', () => {
    expect(() =>
      assertSecureRpcUrl({
        rpcUrl: 'ws://node.internal:51233',
        allowInsecureTransport: true,
        context: 'test',
      }),
    ).not.toThrow()
  })

  it('rejects a malformed url', () => {
    expect(() => assertSecureRpcUrl({ rpcUrl: 'not a url', ...secure })).toThrow('not a valid URL')
  })

  it('is enforced when constructing the charge method', () => {
    expect(() =>
      serverCharge({
        recipient: 'rSomeAddress123',
        network: 'testnet',
        rpcUrl: 'ws://remote-node.example:51233',
        store: Store.memory(),
        storeDurability: 'process-local',
      }),
    ).toThrow('not encrypted')
  })

  it('is enforced when constructing the channel method', () => {
    const funder = Wallet.generate()
    expect(() =>
      serverChannel({
        publicKey: funder.publicKey,
        recipient: funder.address,
        network: 'testnet',
        rpcUrl: 'ws://remote-node.example:51233',
        store: Store.memory(),
        storeDurability: 'process-local',
      }),
    ).toThrow('not encrypted')
  })

  it('accepts the shipped defaults for every network', () => {
    for (const network of ['mainnet', 'testnet', 'devnet'] as const) {
      expect(() =>
        serverCharge({
          recipient: 'rSomeAddress123',
          network,
          store: Store.memory(),
          storeDurability: 'shared',
        }),
      ).not.toThrow()
    }
  })
})
