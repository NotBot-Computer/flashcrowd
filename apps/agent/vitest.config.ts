import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // As in packages/core: wallet-toolbox (CommonJS) loads the CJS build of @bsv/sdk, so ours must be the same build.
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
