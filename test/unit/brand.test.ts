import { existsSync, readFileSync, statSync } from 'node:fs'
import { expect, test } from 'vitest'

test('brand assets exist', () => {
  expect(readFileSync('assets/logo.svg', 'utf8')).toContain('viewBox="0 0 64 64"')
  expect(statSync('build/icon.icns').size).toBeGreaterThan(50_000)
  expect(existsSync('build/icon.png')).toBe(true)
})
