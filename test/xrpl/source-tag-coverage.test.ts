import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MPP_SOURCE_TAG } from '../../sdk/src/constants.js'

/**
 * Every transaction this SDK originates carries `SourceTag` for on-chain
 * attribution. That was the stated intent, but five of the sixteen builders had
 * been missed -- all in the MPT path, including the issuer `Payment` that moves
 * value, while `MPTokenIssuanceCreate` two functions above did carry it. So the
 * MPT flows were invisible in usage figures, which is awkward for one of the
 * capabilities the SDK exists to offer.
 *
 * A grep is the right shape here. The alternative is asserting the tag through
 * every code path, which needs a funded ledger for flows the unit suite cannot
 * reach, and would still miss a builder nobody wrote a test for.
 */

/** Transaction builders are object literals with a `TransactionType` field. */
const BUILDER = /TransactionType:\s*'(\w+)'/g

function sourceFiles(): string[] {
  return globSync('sdk/src/**/*.ts').filter((f) => !f.endsWith('.d.ts'))
}

describe('SourceTag attribution', () => {
  it('is a stable 32-bit value', () => {
    // Changing it silently would orphan every transaction already on-chain.
    expect(MPP_SOURCE_TAG).toBe(593184257)
    expect(Number.isInteger(MPP_SOURCE_TAG)).toBe(true)
    expect(MPP_SOURCE_TAG).toBeLessThanOrEqual(0xffffffff)
  })

  it('is present on every transaction the SDK builds', () => {
    const untagged: string[] = []

    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        const match = [...line.matchAll(BUILDER)]
        if (match.length === 0) return
        // Scan the enclosing literal: from a few lines above to the closing
        // brace, which is where a SourceTag would sit.
        const window = lines.slice(Math.max(0, index - 4), index + 18).join('\n')
        if (!window.includes('SourceTag')) {
          untagged.push(`${file}:${index + 1} ${match[0]![1]}`)
        }
      })
    }

    expect(untagged, 'these transaction builders omit SourceTag').toEqual([])
  })
})
