import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The README's export table drifted from the code: it listed five names for
 * `xrpl-mpp-sdk/server` while the entry point exported nineteen. That mattered
 * because the production-deployment section tells you to use `sqlStore`, a name
 * the table said did not exist -- a reader following the docs concluded the
 * feature was missing.
 *
 * Documentation drifts silently, so this compares the table against the entry
 * points instead of trusting a reviewer to notice. The two directions are
 * deliberately asymmetric: every exported *value* must be listed, since those
 * are what a reader looks up before concluding a feature is missing, while types
 * may be listed or not. Nothing fictional is allowed either way.
 */

const ENTRY_POINTS: Record<string, string> = {
  '`xrpl-mpp-sdk/client`': 'sdk/src/client/index.ts',
  '`xrpl-mpp-sdk/server`': 'sdk/src/server/index.ts',
  '`xrpl-mpp-sdk/channel/client`': 'sdk/src/channel/client/index.ts',
  '`xrpl-mpp-sdk/channel/server`': 'sdk/src/channel/server/index.ts',
}

/**
 * Names an entry point re-exports. `types: true` includes `type` re-exports,
 * which belong to the API surface even though the table need not list them.
 */
function exportedNames(file: string, options: { types: boolean }): Set<string> {
  const source = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of block[1]!.split(',')) {
      let entry = raw.trim()
      if (!entry) continue
      const isType = entry.startsWith('type ')
      if (isType) {
        if (!options.types) continue
        entry = entry.slice('type '.length).trim()
      }
      // `a as b` re-exports under b, which is the name a consumer imports.
      names.add((entry.split(/\s+as\s+/).pop() ?? entry).trim())
    }
  }
  return names
}

/** Names the README's table claims for a given path. */
function documentedNames(path: string): Set<string> {
  const readme = readFileSync('README.md', 'utf8')
  const row = readme.split('\n').find((line) => line.startsWith(`| ${path} |`))
  if (!row) throw new Error(`no export-table row for ${path}`)
  const cell = row.split('|')[2] ?? ''
  return new Set(
    cell
      .split(',')
      .map((name) =>
        name
          .trim()
          .replace(/`/g, '')
          .replace(/\s*\(.*\)$/, ''),
      )
      .filter(Boolean),
  )
}

describe('README export table matches the entry points', () => {
  for (const [path, file] of Object.entries(ENTRY_POINTS)) {
    it(`${path} documents every value it exports`, () => {
      const missing = [...exportedNames(file, { types: false })].filter(
        (n) => !documentedNames(path).has(n),
      )
      expect(missing, `${path} exports these values but the table omits them`).toEqual([])
    })

    it(`${path} documents nothing it does not export`, () => {
      const surface = exportedNames(file, { types: true })
      const ghosts = [...documentedNames(path)].filter((n) => !surface.has(n))
      expect(ghosts, `the table lists these for ${path} but the entry point does not`).toEqual([])
    })
  }
})
