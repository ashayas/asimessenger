import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { addCustom, addPreset, availability, detectPresets, testAcp } from '../../src/main/friends-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'

let bin: string
let db: Db
let repo: Repo
beforeEach(async () => {
  bin = mkdtempSync(join(tmpdir(), 'asi-bin-'))
  process.env['ASI_TEST_PATH'] = `${bin}:/usr/bin:/bin`
  db = await openDb(':memory:')
  repo = createRepo(db)
})
afterEach(() => { delete process.env['ASI_TEST_PATH']; rmSync(bin, { recursive: true, force: true }); db.close() })

const fakeCli = (name: string, version: string) => {
  const p = join(bin, name)
  writeFileSync(p, `#!/bin/sh\necho "${version}"\n`)
  chmodSync(p, 0o755)
}

test('detection finds installed CLIs with versions and reports the rest as missing', async () => {
  fakeCli('claude', '2.1.289 (Claude Code)')
  fakeCli('opencode', '1.18.30')
  const found = await detectPresets()
  const by = Object.fromEntries(found.map((d) => [d.preset.id, d]))
  expect(by['claude']).toMatchObject({ path: join(bin, 'claude'), version: '2.1.289 (Claude Code)' })
  expect(by['opencode']!.version).toBe('1.18.30')
  expect(by['codex']).toMatchObject({ path: null, version: null })
})

test('adding a preset is idempotent and uses the resolved path', async () => {
  fakeCli('codex', 'codex-cli 0.160.0')
  const a = await addPreset(repo, 'codex')
  const b = await addPreset(repo, 'codex')
  expect(b.id).toBe(a.id)
  expect(a).toMatchObject({ harness: 'codex', displayName: 'Codex', command: join(bin, 'codex'), avatar: 'codex' })
  const gem = await addPreset(repo, 'gemini')
  expect(gem).toMatchObject({ harness: 'acp', transport: 'gemini', args: ['--experimental-acp'] })
})

test('availability follows the PATH; built-ins are skipped', async () => {
  fakeCli('claude', '1')
  const claude = await addPreset(repo, 'claude')
  const codex = await addPreset(repo, 'codex')
  const echo = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
  const av = await availability(await repo.friends.list())
  expect(av[claude.id]).toBe(true)
  expect(av[codex.id]).toBe(false)
  expect(av[echo.id]).toBeUndefined()
})

test('custom friends validate input', async () => {
  await expect(addCustom(repo, { name: ' ', command: 'x', args: [], kind: 'acp' })).rejects.toThrow(/name/)
  await expect(addCustom(repo, { name: 'A', command: ' ', args: [], kind: 'acp' })).rejects.toThrow(/command/)
  const f = await addCustom(repo, { name: 'Mine', command: 'my-agent', args: ['acp'], kind: 'acp' })
  expect(f).toMatchObject({ harness: 'acp', transport: 'generic', command: 'my-agent', args: ['acp'] })
})

test('test connection performs the ACP handshake or explains the failure', async () => {
  expect(await testAcp(process.execPath, [resolve('test/fixtures/mock-acp-agent.mjs')])).toEqual({ ok: true, agent: 'ACP agent' })
  expect(await testAcp('definitely-not-real', [])).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
})

test('HTTP friends validate the manifest, keep the token in the keychain and the manifest in args', async () => {
  const stored: Record<string, string> = {}
  const secrets = { set: async (n: string, v: string) => { stored[n] = v } }
  const manifest = JSON.stringify({ baseUrl: 'https://agents.example.com/api', send: { path: '/chat', body: { m: '{{text}}' } }, stream: 'sse', map: { text: 'delta' } })
  await expect(addCustom(repo, { name: 'Remote', command: '', args: [], kind: 'http', manifest: '{oops' }, secrets)).rejects.toThrow(/valid JSON/)
  await expect(addCustom(repo, { name: 'Remote', command: '', args: [], kind: 'http', manifest: manifest.replace('https://agents.example.com/api', 'http://agents.example.com') }, secrets)).rejects.toThrow(/https/)
  const f = await addCustom(repo, { name: 'Remote', command: '', args: [], kind: 'http', manifest, token: ' tok-123 ' }, secrets)
  expect(f).toMatchObject({ harness: 'http', displayName: 'Remote', command: null })
  const saved = JSON.parse(f.args[0]!)
  expect(saved.auth).toEqual({ type: 'bearer', secret: expect.stringMatching(/^http-/) })
  expect(stored[saved.auth.secret]).toBe('tok-123')
  expect(JSON.stringify(f)).not.toContain('tok-123') // the token is not in the database row
})
