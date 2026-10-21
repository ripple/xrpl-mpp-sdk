import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Offline unit tests for the agent loop, run from the monorepo root with
 * `pnpm agent-template:test` (no extra dependencies: it uses the root vitest).
 *
 * The aliases mirror the `paths` in tsconfig.json and are needed for the same
 * reason: inside the monorepo `xrpl-mpp-sdk` is the sibling source tree, not
 * an installed package. If you lift this folder out of the repo, delete them.
 */
const sdk = (path: string) => fileURLToPath(new URL(`../../sdk/src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^xrpl-mpp-sdk$/, replacement: sdk('index.ts') },
      { find: /^xrpl-mpp-sdk\/server$/, replacement: sdk('server/index.ts') },
      { find: /^xrpl-mpp-sdk\/client$/, replacement: sdk('client/index.ts') },
      { find: /^xrpl-mpp-sdk\/channel$/, replacement: sdk('channel/index.ts') },
      { find: /^xrpl-mpp-sdk\/channel\/server$/, replacement: sdk('channel/server/index.ts') },
      { find: /^xrpl-mpp-sdk\/channel\/client$/, replacement: sdk('channel/client/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
