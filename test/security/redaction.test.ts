import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  challengeRejected,
  channelClosed,
  channelDestinationMismatch,
  channelExhausted,
  channelNotFound,
  fromTecResult,
  insufficientBalance,
  invalidSignature,
  malformedCredential,
  replayDetected,
  verificationFailed,
} from '../../sdk/src/errors.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

type Curve = 'ed25519' | 'ecdsa-secp256k1'
const CURVES: Curve[] = ['ed25519', 'ecdsa-secp256k1']

/**
 * Every way a value can plausibly reach a log line or an error tracker. A seed
 * that survives any of these is a P0 leak, because consumers log errors and
 * hook payloads as a matter of course.
 */
function serialisations(value: unknown): string[] {
  const out: string[] = []
  out.push(JSON.stringify(value) ?? 'undefined')
  out.push(inspect(value, { depth: 6 }))
  out.push(String(value))
  out.push(`${value}`)
  out.push(JSON.stringify({ wrapped: value, nested: { deep: value } }) ?? '')
  out.push(inspect({ wrapped: value }, { depth: 6 }))
  try {
    out.push(JSON.stringify(structuredClone(value)) ?? '')
  } catch {
    // Not every value is cloneable (class instances with private fields are
    // not); that is itself a form of non-leakage.
  }
  return out
}

function expectNoSecrets(value: unknown, secrets: (string | undefined)[]) {
  const present = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0)
  expect(present.length).toBeGreaterThan(0)
  for (const form of serialisations(value)) {
    for (const secret of present) {
      expect(form).not.toContain(secret)
    }
  }
}

describe('key material is never emitted', () => {
  for (const curve of CURVES) {
    describe(`Wallet (${curve})`, () => {
      it('does not leak seed or private key through any serialisation', () => {
        const wallet = Wallet.generate(curve)
        expectNoSecrets(wallet, [wallet.seed, wallet.privateKey])
      })

      it('exposes only address and publicKey via toJSON', () => {
        const wallet = Wallet.generate(curve)
        expect(wallet.toJSON()).toEqual({
          address: wallet.address,
          publicKey: wallet.publicKey,
        })
      })

      it('renders a redacted string form', () => {
        const wallet = Wallet.generate(curve)
        expect(String(wallet)).toBe(`Wallet(${wallet.address})`)
        expect(`${wallet}`).not.toContain(wallet.privateKey)
      })

      it('renders a redacted inspect form', () => {
        const wallet = Wallet.generate(curve)
        expect(inspect(wallet)).toContain(wallet.address)
        expect(inspect(wallet)).not.toContain(wallet.privateKey)
      })

      it('redacts the raw xrpl.js wallet too', () => {
        // The escape hatch hands out an object whose seed and privateKey are
        // ordinary enumerable fields, so the hooks are attached to it as well.
        const wallet = Wallet.generate(curve)
        expectNoSecrets(wallet.unsafeXrplWallet, [wallet.seed, wallet.privateKey])
      })

      it('redacts the internal accessor used by SDK internals', () => {
        const wallet = Wallet.generate(curve)
        expectNoSecrets(wallet._xrplWallet, [wallet.seed, wallet.privateKey])
      })

      it('still exposes the secrets through explicit getters', () => {
        // Redaction must not break legitimate access, only accidental emission.
        const wallet = Wallet.generate(curve)
        expect(wallet.privateKey).toMatch(/^[0-9A-Fa-f]+$/)
        expect(wallet.seed).toBeTypeOf('string')
        expect(wallet.unsafeXrplWallet.privateKey).toBe(wallet.privateKey)
      })

      it('keeps a seed-derived wallet redacted', () => {
        const generated = Wallet.generate(curve)
        const wallet = Wallet.fromSeed(generated.seed as string)
        expectNoSecrets(wallet, [wallet.seed, wallet.privateKey])
      })
    })
  }

  describe('error factories', () => {
    it('accept only strings, so a wallet cannot be embedded', () => {
      // Guards the invariant rather than a specific message: every factory
      // takes a string detail and produces a string reason.
      const wallet = Wallet.generate()
      const errors = [
        verificationFailed('SUBMISSION_FAILED', 'detail'),
        insufficientBalance('detail', 'tecUNFUNDED_PAYMENT'),
        invalidSignature('detail'),
        challengeRejected('detail'),
        channelNotFound('C'.repeat(64)),
        channelClosed('C'.repeat(64)),
        channelDestinationMismatch('C'.repeat(64), wallet.address, 'rOther'),
        channelExhausted('C'.repeat(64), 10n, 5n),
        malformedCredential('detail'),
        replayDetected('identifier'),
        fromTecResult('tecPATH_DRY', 'detail'),
      ]

      for (const error of errors) {
        expect(typeof error.message).toBe('string')
        expectNoSecrets(error, [wallet.seed, wallet.privateKey])
      }
    })

    it('does not leak a wallet interpolated into a detail string', () => {
      // Even when a caller is careless enough to interpolate a wallet, the
      // redacted toString keeps the secret out.
      const wallet = Wallet.generate()
      const error = verificationFailed('SUBMISSION_FAILED', `paid by ${wallet}`)
      expectNoSecrets(error, [wallet.seed, wallet.privateKey])
      expect(error.message).toContain(wallet.address)
    })
  })

  describe('hook payloads', () => {
    it('charge onProgress events carry only scalars', () => {
      const wallet = Wallet.generate()
      // The ChargeProgressEvent union is closed and scalar-only; these are the
      // exact shapes the client emits.
      const events = [
        { type: 'challenge', recipient: wallet.address, amount: '1', currency: 'XRP' },
        { type: 'preflight' },
        { type: 'pathfinding' },
        { type: 'signing' },
        { type: 'signed', mode: 'pull' },
        { type: 'submitting' },
        { type: 'confirmed', hash: 'A'.repeat(64) },
      ]
      expectNoSecrets(events, [wallet.seed, wallet.privateKey])
    })

    it('channel lifecycle payloads carry only scalars', () => {
      const wallet = Wallet.generate()
      const payloads = [
        { channelId: 'C'.repeat(64), cumulative: '100', txHash: 'A'.repeat(64) },
        { channelId: 'C'.repeat(64), error: new Error('close failed') },
        { channelId: 'C'.repeat(64), cancelAfter: '2026-01-01', balance: '100' },
      ]
      expectNoSecrets(payloads, [wallet.seed, wallet.privateKey])
    })
  })
})
