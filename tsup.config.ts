import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'sdk/src/index.ts',
    'client/index': 'sdk/src/client/index.ts',
    'server/index': 'sdk/src/server/index.ts',
    'channel/index': 'sdk/src/channel/index.ts',
    'channel/client/index': 'sdk/src/channel/client/index.ts',
    'channel/server/index': 'sdk/src/channel/server/index.ts',
  },
  format: 'esm',
  dts: true,
  // No sourcemaps in the published artifact: they carry the original source,
  // including comments and internal structure, into every consumer's
  // node_modules for no runtime benefit. Debug against the repo instead.
  sourcemap: false,
  clean: true,
  outDir: 'dist',
  external: ['xrpl', 'mppx'],
})
