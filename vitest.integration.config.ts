import { defineConfig } from 'vitest/config'

/**
 * Integration vitest config -- runs against the public XRPL devnet.
 *
 * Each test funds its own ephemeral wallets via the devnet faucet, exercises
 * the full SDK flow (charge / channel) end-to-end, and exits without cleanup.
 * No production keys, no shared state across tests.
 *
 * Run via `pnpm test:integration` or in CI's gated job.
 */
export default defineConfig({
  test: {
    globals: true,
    // Faucet calls + tx confirmations can take several seconds; allow generous
    // per-test timeout so the suite is robust on slow networks.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ['test/integration/**/*.test.ts'],
    // Integration tests serialise so they don't fight over devnet rate limits.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // No coverage from integration tests -- they assert correctness, not
    // line coverage.
    coverage: { enabled: false },
  },
})
