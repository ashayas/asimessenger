import { defineConfig } from '@playwright/test'

// Smoke test of the real packaged app: pnpm dist:dir && pnpm test:packaged
export default defineConfig({ testDir: 'test/packaged', timeout: 90_000, workers: 1, reporter: 'list' })
