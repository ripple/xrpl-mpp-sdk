#!/usr/bin/env node
/**
 * Fail the build on XRPL key material committed to the repository.
 *
 * Platform secret scanning covers provider tokens, but XRPL family seeds are
 * not a recognised provider pattern, so push protection does not catch them.
 * This closes that gap locally and in CI, independent of platform settings.
 *
 * Detects:
 * - ed25519 family seeds (`sEd` + 28 base58 characters)
 * - secp256k1 family seeds (`s` + 28 base58 characters)
 *
 * Both are validated with a base58check decode before being reported, so a
 * random string that merely looks seed-shaped does not trip the scan.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { decodeSeed } from 'xrpl'

/** Files whose whole purpose is to describe the pattern being scanned for. */
const ALLOWLIST = new Set(['scripts/scan-secrets.mjs'])

const CANDIDATE = /\b(s[1-9A-HJ-NP-Za-km-z]{28,})\b/g

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

/** A candidate is a real seed only if it decodes as one. */
function isSeed(candidate) {
  try {
    decodeSeed(candidate)
    return true
  } catch {
    return false
  }
}

const findings = []

for (const file of trackedFiles()) {
  if (ALLOWLIST.has(file)) continue
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    continue // binary or unreadable
  }
  if (!content.includes('s')) continue

  for (const [, candidate] of content.matchAll(CANDIDATE)) {
    if (!isSeed(candidate)) continue
    const line = content.slice(0, content.indexOf(candidate)).split('\n').length
    // Report the location and a truncated prefix only. Printing the full seed
    // would move it from the repository into CI logs.
    findings.push(`${file}:${line} -- ${candidate.slice(0, 6)}... (${candidate.length} chars)`)
  }
}

if (findings.length > 0) {
  console.error('XRPL seed material found in tracked files:\n')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error(
    '\nGenerate wallets at runtime instead (Wallet.generate(), Wallet.fromFaucet()), or use a\n' +
      'bare address constant when only the address matters. Never commit a seed, even a\n' +
      'testnet one: it establishes the pattern that leads to a mainnet seed being pasted in.',
  )
  process.exit(1)
}

console.log(`No XRPL seed material in ${trackedFiles().length} tracked files.`)
