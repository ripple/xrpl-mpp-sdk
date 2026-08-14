import { describe, expect, it } from 'vitest'
import { ECDSA, Wallet } from 'xrpl'

describe('XRPL Dual Curve Support', () => {
  describe('Wallet key types', () => {
    it('ed25519 wallet has public key with ED prefix', () => {
      const wallet = Wallet.generate(ECDSA.ed25519)
      expect(wallet.publicKey.startsWith('ED')).toBe(true)
    })

    it('secp256k1 wallet has public key without ED prefix', () => {
      const wallet = Wallet.generate(ECDSA.secp256k1)
      expect(wallet.publicKey.startsWith('ED')).toBe(false)
    })

    it('ed25519 seed has sEd prefix', () => {
      const wallet = Wallet.generate(ECDSA.ed25519)
      expect(wallet.seed!.startsWith('sEd')).toBe(true)
    })

    it('secp256k1 seed starts with s (no Ed)', () => {
      const wallet = Wallet.generate(ECDSA.secp256k1)
      expect(wallet.seed!.startsWith('s')).toBe(true)
      expect(wallet.seed!.startsWith('sEd')).toBe(false)
    })

    it('both wallet types produce valid classic addresses', () => {
      const ed = Wallet.generate(ECDSA.ed25519)
      const secp = Wallet.generate(ECDSA.secp256k1)

      expect(ed.classicAddress).toMatch(/^r[a-zA-Z0-9]{24,34}$/)
      expect(secp.classicAddress).toMatch(/^r[a-zA-Z0-9]{24,34}$/)
    })
  })

  describe('PayChannel claim signing', () => {
    it('signPaymentChannelClaim is importable from xrpl', async () => {
      const xrpl = await import('xrpl')
      expect(typeof xrpl.signPaymentChannelClaim).toBe('function')
    })

    it('verifyPaymentChannelClaim is importable from xrpl', async () => {
      const xrpl = await import('xrpl')
      expect(typeof xrpl.verifyPaymentChannelClaim).toBe('function')
    })
  })
})
