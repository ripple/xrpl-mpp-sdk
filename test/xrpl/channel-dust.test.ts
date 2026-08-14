import { describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'
import { openChannel } from '../../sdk/src/channel/client/Channel.js'

describe('openChannel -- dust validation', () => {
  it('rejects amount of 0 drops with INVALID_AMOUNT', async () => {
    const wallet = Wallet.generate()
    await expect(
      openChannel({
        seed: wallet.seed!,
        destination: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        amount: '0',
        settleDelay: 60,
        network: 'testnet',
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*must be > 0 drops/)
  })

  it('rejects negative amount with INVALID_AMOUNT', async () => {
    const wallet = Wallet.generate()
    await expect(
      openChannel({
        seed: wallet.seed!,
        destination: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        amount: '-100',
        settleDelay: 60,
        network: 'testnet',
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*must be > 0 drops/)
  })

  it('rejects negative settleDelay with INVALID_AMOUNT', async () => {
    const wallet = Wallet.generate()
    await expect(
      openChannel({
        seed: wallet.seed!,
        destination: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
        amount: '1000000',
        settleDelay: -1,
        network: 'testnet',
      }),
    ).rejects.toThrow(/INVALID_AMOUNT.*settleDelay/)
  })
})
