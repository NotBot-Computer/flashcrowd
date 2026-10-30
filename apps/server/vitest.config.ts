import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // As in packages/core: the mock chain needs one build of @bsv/sdk, the one wallet-toolbox (CommonJS) loads.
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
