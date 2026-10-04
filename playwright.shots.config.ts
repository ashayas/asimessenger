import { defineConfig } from '@playwright/test'

// Regenerates docs/images from a scripted demo scene: pnpm shots
export default defineConfig({ testDir: 'test/screenshots', timeout: 180_000, workers: 1, reporter: 'list' })
