import { defineConfig } from 'vitest/config'

/**
 * Default vitest config -- unit and security tests, no real ledger access.
 *
 * Integration tests live under `test/integration/` and are run via
 * `vitest.integration.config.ts` to keep the unit suite fast and offline.
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**', 'dist/**'],
    // The mppx response-clone hazard only bites once the unread clone is
    // collected, so reproducing it needs a deliberate collection rather than a
    // wait. Tests that use it skip themselves when `globalThis.gc` is absent,
    // which is why this has to stay a top-level key: Vitest 4 removed
    // `test.poolOptions` and ignores it in silence, taking three tests with it.
    execArgv: ['--expose-gc'],
  },
})
