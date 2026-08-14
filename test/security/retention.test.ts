import { Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PayChannelLedgerEntry,
  channel as serverChannel,
} from '../../sdk/src/channel/server/Channel.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { storeKeys } from '../../sdk/src/utils/keys.js'
import { claimKey, replayRetentionFor } from '../../sdk/src/utils/store.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

const NETWORK = 'testnet'
const keys = storeKeys(NETWORK)

/** A memory store that records every key it is asked to write. */
function observableStore() {
  const inner = Store.memory()
  const written = new Set<string>()
  return {
    written,
    get: inner.get,
    delete: inner.delete,
    async put(key: string, value: unknown) {
      written.add(key)
      return inner.put(key, value as never)
    },
    update<result>(key: string, fn: (current: unknown) => any): Promise<result> {
      return inner.update(
        key as never,
        ((current: unknown) => {
          const change = fn(current)
          if (change.op === 'set') written.add(key)
          return change
        }) as never,
      ) as Promise<result>
    },
  }
}

describe('replay key retention', () => {
  describe('replayRetentionFor', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z')

    it('derives retention from the remaining expires window', () => {
      // 5 minutes left on the challenge + 60s poll budget + 60s skew.
      expect(
        replayRetentionFor({
          expiresIso: '2026-01-01T00:05:00.000Z',
          pollTimeout: 60_000,
          nowMs: now,
        }),
      ).toBe(300_000 + 60_000 + 60_000)
    })

    it('always exceeds the window in which the credential stays presentable', () => {
      // The invariant that makes bounded retention safe: a claim must outlive
      // the remaining expires window plus verification time.
      for (const remaining of [1_000, 60_000, 3_600_000]) {
        const retention = replayRetentionFor({
          expiresIso: new Date(now + remaining).toISOString(),
          pollTimeout: 60_000,
          nowMs: now,
        })
        expect(retention).toBeGreaterThan(remaining + 60_000)
      }
    })

    it('retains forever when expires is absent', () => {
      // No authenticated bound on the presentable window means no finite
      // retention can be justified, so fail safe rather than guess.
      expect(replayRetentionFor({ expiresIso: undefined, pollTimeout: 60_000 })).toBeUndefined()
    })

    it('retains forever when expires is malformed', () => {
      expect(replayRetentionFor({ expiresIso: 'not-a-date', pollTimeout: 60_000 })).toBeUndefined()
    })

    it('clamps an already-expired challenge to the verification budget', () => {
      // Never negative, which would mark the claim instantly lapsed.
      expect(
        replayRetentionFor({
          expiresIso: '2025-12-31T23:00:00.000Z',
          pollTimeout: 60_000,
          nowMs: now,
        }),
      ).toBe(120_000)
    })
  })

  describe('claimKey expiry', () => {
    it('refuses a second claim while the first is live', async () => {
      const store = Store.memory()
      expect(await claimKey(store, 'k', { a: 1 }, 60_000)).toBe(true)
      expect(await claimKey(store, 'k', { a: 2 }, 60_000)).toBe(false)
    })

    it('allows a claim once retention has lapsed', async () => {
      const store = Store.memory()
      vi.useFakeTimers()
      try {
        expect(await claimKey(store, 'k', { a: 1 }, 60_000)).toBe(true)
        vi.advanceTimersByTime(59_000)
        expect(await claimKey(store, 'k', { a: 2 }, 60_000)).toBe(false)
        vi.advanceTimersByTime(2_000)
        expect(await claimKey(store, 'k', { a: 3 }, 60_000)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('reuses the key rather than accumulating a second one', async () => {
      const store = observableStore()
      vi.useFakeTimers()
      try {
        await claimKey(store as never, 'k', { a: 1 }, 1_000)
        vi.advanceTimersByTime(2_000)
        await claimKey(store as never, 'k', { a: 2 }, 1_000)
        expect(store.written.size).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('never expires a claim written without retention', async () => {
      const store = Store.memory()
      vi.useFakeTimers()
      try {
        expect(await claimKey(store, 'k', { a: 1 })).toBe(true)
        vi.advanceTimersByTime(365 * 24 * 3_600_000)
        expect(await claimKey(store, 'k', { a: 2 })).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('charge: no store write before the credential is validated', () => {
    const recipient = 'rfFfsSUDjJyKLXMtXLQvo572PZzbx2e9MC'

    function challengeFor(id: string) {
      return {
        id,
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'charge' as const,
        expires: new Date(Date.now() + 300_000).toISOString(),
        request: {
          amount: '1000000',
          currency: 'XRP',
          recipient,
          methodDetails: { network: NETWORK },
        },
      }
    }

    it('rejects an undecodable blob without consuming a store entry', async () => {
      const store = observableStore()
      const method = serverCharge({
        recipient,
        network: NETWORK,
        store: store as never,
        storeDurability: 'process-local',
      })
      const challenge = challengeFor('junk-blob')
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { type: 'transaction', blob: 'DEADBEEF' },
        source: `did:pkh:xrpl:${NETWORK}:${Wallet.generate().address}`,
      })

      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow()
      expect(store.written.size).toBe(0)
    })

    it('leaves the challenge reusable after a malformed attempt', async () => {
      // The client should be able to retry the same challenge: the previous
      // attempt never carried a payment, so nothing was consumed.
      const store = observableStore()
      const method = serverCharge({
        recipient,
        network: NETWORK,
        store: store as never,
        storeDurability: 'process-local',
      })
      const challenge = challengeFor('retryable')
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { type: 'transaction', blob: 'DEADBEEF' },
        source: `did:pkh:xrpl:${NETWORK}:${Wallet.generate().address}`,
      })

      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow()

      expect(await store.get(keys.challenge('retryable'))).toBeNull()
    })

    it('rejects an expired challenge without a store write', async () => {
      const store = observableStore()
      const method = serverCharge({
        recipient,
        network: NETWORK,
        store: store as never,
        storeDurability: 'process-local',
      })
      const challenge = {
        ...challengeFor('stale'),
        expires: new Date(Date.now() - 60_000).toISOString(),
      }
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { type: 'transaction', blob: 'DEADBEEF' },
        source: `did:pkh:xrpl:${NETWORK}:${Wallet.generate().address}`,
      })

      await expect(
        method.verify({ credential: cred as any, request: challenge.request }),
      ).rejects.toThrow(/Challenge expired/)
      expect(store.written.size).toBe(0)
    })
  })

  describe('channel marker retention', () => {
    it('retains forever when the challenge carries no expires', async () => {
      // The channel paths briefly substituted a 5-minute guess here. On the open
      // action the challenge marker is the only single-use gate before a
      // submission is spent, so a marker that lapses while the credential never
      // expires lets a captured open credential be replayed.
      const store = Store.memory()
      const retention = replayRetentionFor({ expiresIso: undefined, pollTimeout: 0 })
      expect(retention).toBeUndefined()

      await claimKey(store, 'chan-marker', { usedAt: 'now' }, retention)
      const record = (await store.get('chan-marker')) as { expiresAt?: number } | null
      expect(record?.expiresAt).toBeUndefined()

      vi.useFakeTimers()
      try {
        vi.advanceTimersByTime(365 * 24 * 3_600_000)
        expect(await claimKey(store, 'chan-marker', { usedAt: 'later' }, retention)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('channel: no store write on attacker-supplied input', () => {
    let funder: Wallet
    let recipient: Wallet

    beforeEach(() => {
      funder = Wallet.generate()
      recipient = Wallet.generate()
    })

    function voucher(channelId: string, cumulative: string) {
      const signature = funder.signChannelClaim(channelId, cumulative)
      const challenge = {
        id: `ch-${channelId.slice(0, 8)}-${Math.random()}`,
        realm: 'test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        createdAt: new Date().toISOString(),
        request: {
          amount: cumulative,
          channelId,
          recipient: recipient.address,
          methodDetails: { network: NETWORK, cumulativeAmount: '0' },
        },
      }
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId, amount: cumulative, signature },
        source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
      })
      return { challenge, cred }
    }

    it('does not tombstone a channel that does not exist', async () => {
      // A tombstone for an absent channel would let any client grow the store
      // by sending fabricated 64-hex channel IDs.
      const store = observableStore()
      const fabricated = 'F'.repeat(64)
      const method = serverChannel({
        publicKey: funder.publicKey,
        recipient: recipient.address,
        network: NETWORK,
        store: store as never,
        storeDurability: 'process-local',
        verifyChannelOnChain: true,
        channelLookup: vi.fn(async () => null),
      })
      const v = voucher(fabricated, '100000')

      await expect(
        method.verify({ credential: v.cred as any, request: v.challenge.request }),
      ).rejects.toThrow(/CHANNEL_NOT_FOUND/)

      expect(store.written.has(keys.channelFinalized(fabricated))).toBe(false)
      expect(await store.get(keys.channelFinalized(fabricated))).toBeNull()
    })

    it('does not consume the challenge when the signature is forged', async () => {
      const store = observableStore()
      const channelId = 'A'.repeat(64)
      const entry: PayChannelLedgerEntry = {
        Account: funder.address,
        Destination: recipient.address,
        Amount: '10000000',
        Balance: '0',
        PublicKey: funder.publicKey,
        SettleDelay: 3600,
        Expiration: null,
        CancelAfter: null,
      }
      const method = serverChannel({
        publicKey: funder.publicKey,
        recipient: recipient.address,
        network: NETWORK,
        store: store as never,
        storeDurability: 'process-local',
        verifyChannelOnChain: true,
        channelLookup: vi.fn(async () => entry),
      })

      const v = voucher(channelId, '100000')
      ;(v.cred as any).payload.signature = 'DEADBEEF'

      await expect(
        method.verify({ credential: v.cred as any, request: v.challenge.request }),
      ).rejects.toThrow(/INVALID_SIGNATURE/)

      expect(await store.get(keys.challenge(v.challenge.id))).toBeNull()
    })
  })
})
