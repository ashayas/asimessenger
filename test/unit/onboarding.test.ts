import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { ensureDefaults } from '../../src/main/defaults'
import { completeOnboarding, isOnboarded } from '../../src/main/onboarding'

let bin: string
let db: Db
let repo: Repo
beforeEach(async () => {
  bin = mkdtempSync(join(tmpdir(), 'asi-ob-'))
  for (const c of ['claude', 'codex']) { writeFileSync(join(bin, c), '#!/bin/sh\necho 1.0\n'); chmodSync(join(bin, c), 0o755) }
  process.env['ASI_TEST_PATH'] = `${bin}:/usr/bin:/bin`
  db = await openDb(':memory:')
  repo = createRepo(db)
  await ensureDefaults(repo)
})
afterEach(() => { delete process.env['ASI_TEST_PATH']; rmSync(bin, { recursive: true, force: true }); db.close() })

test('completing onboarding sets the name, points the first workspace at your folder and adds picked agents', async () => {
  expect(await isOnboarded(repo)).toBe(false)
  await completeOnboarding(repo, { name: '  Ashaya ', workspacePath: '/Users/me/code/honeycomb', presetIds: ['claude', 'codex'] })
  expect(await isOnboarded(repo)).toBe(true)
  expect((await repo.settings.get('profile', null as never))).toMatchObject({ name: 'Ashaya' })
  const ws = await repo.workspaces.list()
  expect(ws).toHaveLength(1)
  expect(ws[0]).toMatchObject({ name: 'honeycomb', path: '/Users/me/code/honeycomb', slot: 1 })
  expect((await repo.friends.list()).map((f) => f.displayName)).toEqual(['ASI', 'Echo', 'Claude Code', 'Codex'])
})

test('a name is required, nothing is saved on failure, and running twice does not duplicate agents', async () => {
  await expect(completeOnboarding(repo, { name: '   ', workspacePath: '/x', presetIds: ['claude'] })).rejects.toThrow(/call you/)
  expect(await isOnboarded(repo)).toBe(false)
  await completeOnboarding(repo, { name: 'A', workspacePath: '', presetIds: ['claude'] })
  await completeOnboarding(repo, { name: 'A', workspacePath: '', presetIds: ['claude'] })
  expect((await repo.friends.list()).filter((f) => f.displayName === 'Claude Code')).toHaveLength(1)
  expect((await repo.workspaces.list())[0]!.name).toBe('Home') // empty path leaves the default workspace alone
})
