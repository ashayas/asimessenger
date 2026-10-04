import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Live contract tests against the real CLIs installed on this machine. Run: pnpm test:live
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['test/live/**/*.live.test.ts'], environment: 'node', testTimeout: 180_000, hookTimeout: 60_000, fileParallelism: false }
})
