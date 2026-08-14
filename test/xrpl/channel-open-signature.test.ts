import { Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'
import { storeKeys } from '../../sdk/src/utils/keys.js'

// Deterministic channelId returned by the mocked PaymentChannelCreate. The
// real ledger derives this from Account + Sequence + nonce, but for test
// purposes we just want a stable 64-hex string the server can extract from
// the mocked tx metadata.
const FAKE_CHANNEL_ID = 'A'.repeat(64)
const FAKE_TX_HASH = 'B'.repeat(64)
const FAKE_CURRENT_LEDGER_INDEX = 1_000

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async submit(_blob: string) {
      return {
        result: {
          engine_result: 'tesSUCCESS',
          tx_json: { hash: FAKE_TX_HASH },
        },
      }
    }
    async request(params: any) {
      if (params.command === 'tx') {
        return {
          result: {
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  CreatedNode: {
                    LedgerEntryType: 'PayChannel',
                    LedgerIndex: FAKE_CHANNEL_ID,
                  },
                },
              ],
            },
          },
        }
      }
      if (params.command === 'ledger_current') {
        return { result: { ledger_current_index: FAKE_CURRENT_LEDGER_INDEX } }
      }
      return { result: {} }
    }
  }
  return { ...actual, Client: FakeClient }
})

const { channel: serverChannel } = await import('../../sdk/src/channel/server/Channel.js')
const { Wallet, encode, signPaymentChannelClaim, dropsToXrp } = await import('xrpl')

const NETWORK = 'testnet'

function buildOpenCredential(args: {
  funder: InstanceType<typeof Wallet>
  recipient: string
  initialAmountDrops: string
  /** channelId the client signs against. Use undefined for the placeholder default. */
  signOverChannelId?: string
  /** Override the tx's LastLedgerSequence. Defaults to a far-future value. */
  lastLedgerSequence?: number
  /** Override the challenge.expires field. Use undefined to omit it. */
  challengeExpires?: string | undefined
}) {
  const {
    funder,
    recipient,
    initialAmountDrops,
    signOverChannelId,
    lastLedgerSequence,
    challengeExpires,
  } = args
  const placeholder = '0'.repeat(64)
  const channelIdToSign = signOverChannelId ?? placeholder

  // A real PaymentChannelCreate blob the server's decode() can parse.
  const tx = {
    TransactionType: 'PaymentChannelCreate' as const,
    Account: funder.classicAddress,
    Destination: recipient,
    Amount: '5000000',
    SettleDelay: 60,
    PublicKey: funder.publicKey,
    Fee: '12',
    Sequence: 1,
    SigningPubKey: funder.publicKey,
    Flags: 0,
    LastLedgerSequence: lastLedgerSequence ?? 100_000_000,
  }
  const signed = funder.sign(tx as any)

  // Sign the initial claim against whichever channelId the test specifies.
  const signature = signPaymentChannelClaim(
    channelIdToSign,
    dropsToXrp(initialAmountDrops).toString(),
    funder.privateKey,
  )

  const challenge: any = {
    id: `open-sig-${Math.random().toString(36).slice(2)}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    request: {
      amount: initialAmountDrops,
      // For the open action, the client doesn't yet know the channelId.
      channelId: '',
      recipient,
      methodDetails: { network: NETWORK, cumulativeAmount: '0' },
    },
  }
  if (challengeExpires !== undefined) {
    challenge.expires = challengeExpires
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: {
      action: 'open' as const,
      transaction: signed.tx_blob,
      amount: initialAmountDrops,
      signature,
    },
    source: `did:pkh:xrpl:${NETWORK}:${funder.classicAddress}`,
  })

  return { challenge, cred }
}

describe('channel open -- placeholder signature handling', () => {
  it('accepts open with initialAmount=0 even though placeholder sig does not verify', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate().classicAddress

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      // doVerifyOpen does not consult channelLookup, so this test exercises
      // the post-broadcast validation path directly via the vi.mock'd Client.
      verifyChannelOnChain: false,
      allowUnverifiedChannels: true,
    })

    const { challenge, cred } = buildOpenCredential({
      funder,
      recipient,
      initialAmountDrops: '0',
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')

    const state = (await store.get(storeKeys(NETWORK).channel(FAKE_CHANNEL_ID))) as any
    expect(state.cumulative).toBe('0')
    expect(state.signature).toBe('')
  })

  it('rejects open with initialAmount > 0 when placeholder sig does not verify against real channelId', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate().classicAddress

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: false,
      allowUnverifiedChannels: true,
    })

    const { challenge, cred } = buildOpenCredential({
      funder,
      recipient,
      initialAmountDrops: '500000',
      // Sign against the placeholder -- won't match FAKE_CHANNEL_ID
    })

    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/Initial claim signature does not verify/)

    // No store entry created on rejection.
    const state = await store.get(storeKeys(NETWORK).channel(FAKE_CHANNEL_ID))
    expect(state).toBeNull()
  })

  it('accepts open with initialAmount > 0 when client signs against the real channelId', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate().classicAddress

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: false,
      allowUnverifiedChannels: true,
    })

    const { challenge, cred } = buildOpenCredential({
      funder,
      recipient,
      initialAmountDrops: '500000',
      // Client knows the channelId in advance (e.g., it was negotiated), so
      // it can sign against the real one. The mock returns FAKE_CHANNEL_ID.
      signOverChannelId: FAKE_CHANNEL_ID,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')

    const state = (await store.get(storeKeys(NETWORK).channel(FAKE_CHANNEL_ID))) as any
    expect(state.cumulative).toBe('500000')
    expect(state.signature).toMatch(/^[0-9A-F]+$/i)
  })

  it('rejects open when tx LastLedgerSequence outlives challenge.expires', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate().classicAddress

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: false,
      allowUnverifiedChannels: true,
    })

    // Cap is current (1000) + ceil(60_000 / 4_000) = 1015, plus 4 ledgers
    // of slack -> allowed up to 1019. A LastLedgerSequence of 100_000 is
    // *far* past that, so the server must reject before submit.
    const expires = new Date(Date.now() + 60_000).toISOString()
    const { challenge, cred } = buildOpenCredential({
      funder,
      recipient,
      initialAmountDrops: '0',
      challengeExpires: expires,
      lastLedgerSequence: 100_000,
    })

    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/LastLedgerSequence .* exceeds the cap .* derived from challenge\.expires/)
  })

  it('rejects open when challenge has already expired', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate().classicAddress

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: false,
      allowUnverifiedChannels: true,
    })

    const expires = new Date(Date.now() - 1_000).toISOString()
    const { challenge, cred } = buildOpenCredential({
      funder,
      recipient,
      initialAmountDrops: '0',
      challengeExpires: expires,
    })

    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
      // Rejected by the freshness check on `expires` itself, before the
      // LastLedgerSequence cap further down gets a chance to matter. `expires` is
      // the only temporal field an mppx challenge actually carries.
    ).rejects.toThrow(/Challenge expired at/)
  })

  it('accepts open when tx LastLedgerSequence is within the challenge window', async () => {
    const funder = Wallet.generate()
    const recipient = Wallet.generate().classicAddress

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      recipient,
      network: NETWORK,
      store,
      storeDurability: 'process-local',
      verifyChannelOnChain: false,
      allowUnverifiedChannels: true,
    })

    // Mock returns ledger_current_index = 1000. With expires 5 min from now,
    // the cap is ~1075 + 4 slack = 1079. LLS 1050 fits comfortably.
    const expires = new Date(Date.now() + 5 * 60_000).toISOString()
    const { challenge, cred } = buildOpenCredential({
      funder,
      recipient,
      initialAmountDrops: '0',
      challengeExpires: expires,
      lastLedgerSequence: 1_050,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  // encode export sanity check -- if xrpl renames it the test file fails loudly.
  it('uses xrpl encode helper', () => {
    expect(typeof encode).toBe('function')
  })
})
