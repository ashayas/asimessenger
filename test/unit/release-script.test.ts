import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

let bin: string
beforeEach(() => { bin = mkdtempSync(join(tmpdir(), 'asi-rel-')) })
afterEach(() => rmSync(bin, { recursive: true, force: true }))

const fake = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755) }
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', ['scripts/release-signed.sh', ...args], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ...env } })

test('refuses without a Developer ID Application certificate (Apple Development is not enough)', () => {
  fake('security', 'echo \'  1) ABC "Apple Development: someone@example.com (X1)"\'')
  const r = run(['--check'])
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('Developer ID Application')
})

test('refuses without notary credentials, then passes --check when both exist', () => {
  fake('security', 'echo \'  1) ABC "Developer ID Application: Vartabase (TEAM1)"\'')
  fake('xcrun', 'exit 1')
  let r = run(['--check'])
  expect(r.status).toBe(2)
  expect(r.stderr).toContain('ASI_NOTARY_PROFILE')
  r = run(['--check'], { ASI_NOTARY_PROFILE: 'p' })
  expect(r.status).toBe(2)
  expect(r.stderr).toContain("notarytool profile 'p' is not usable")
  fake('xcrun', 'exit 0')
  r = run(['--check'], { ASI_NOTARY_PROFILE: 'p' })
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('identity: Developer ID Application: Vartabase (TEAM1)')
  expect(r.stdout).toContain('ready to release')
})

test('unknown options are rejected', () => {
  expect(run(['--nope']).status).toBe(64)
})
