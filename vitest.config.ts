import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  test: { include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'], environment: 'node', testTimeout: 20_000 } // the first spawn of a login shell (PATH lookup) can take seconds while other suites run git
})
