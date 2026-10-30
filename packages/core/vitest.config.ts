import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // From the token kit's vitest.config.ts: wallet-toolbox is CommonJS and loads the CJS build of @bsv/sdk, so
      // our code must load the same build, or SDK objects (Transaction, Script…) come from two copies of each class.
      // require.resolve finds that build where npm workspaces put it (the root node_modules).
      '@bsv/sdk': createRequire(import.meta.url).resolve('@bsv/sdk'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
