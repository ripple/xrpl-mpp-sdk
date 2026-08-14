import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * No source outside the key builder may spell a store key literally.
 *
 * The network-namespacing change renamed every replay key. Eight demo and
 * marketplace files still read the old shape, so they silently got `null` back
 * -- one of them aborted after committing real funds on-ledger. Nothing caught
 * it: the SDK compiled, the suite passed, and `demo/` is outside the build
 * tsconfig so `tsc` never looked at it.
 *
 * This guard is deliberately a grep rather than a type check. The failure mode
 * is a string that stopped matching, which no type system sees, and it covers
 * demos and examples that a `tsc` gate over the whole repo cannot yet reach
 * (see tsconfig.check.json).
 */
const ALLOWED = new Set([
  // The builder itself, and the tests that assert its output.
  'sdk/src/utils/keys.ts',
  'test/security/key-namespacing.test.ts',
  'test/security/key-usage.test.ts',
])

/** Matches a literal store key: `xrpl:` followed by anything key-shaped. */
const LITERAL_KEY = /['"`]xrpl:(?!\$\{)[a-z-]/

function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '*.ts'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

describe('store key construction', () => {
  it('is centralised in the key builder', () => {
    const offenders: string[] = []

    for (const file of trackedSources()) {
      if (ALLOWED.has(file)) continue
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, index) => {
        // Prose describing the layout is fine; only code is a drift risk.
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (LITERAL_KEY.test(line)) offenders.push(`${file}:${index + 1}`)
      })
    }

    expect(
      offenders,
      'Build store keys with storeKeys(network) from sdk/src/utils/keys.ts. A literal key ' +
        'silently stops matching when the layout changes, and demos are not type-checked.',
    ).toEqual([])
  })

  it('detects a reintroduced literal key', () => {
    // Proves the matcher works, so a green result above means something.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text to match against, not an interpolation
    expect(LITERAL_KEY.test('await store.get(`xrpl:channel:${channelId}`)')).toBe(true)
    expect(LITERAL_KEY.test("store.get('xrpl:tx:' + hash)")).toBe(true)
    expect(LITERAL_KEY.test('store.get(keys.channel(channelId))')).toBe(false)
    // The builder's own template, which composes the prefix, is not a literal key.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text to match against, not an interpolation
    expect(LITERAL_KEY.test('const prefix = `xrpl:${network}`')).toBe(false)
  })
})
