import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { attachmentPrompt, kindForFile } from '../../src/shared/attachments'
import { loadAttachment, readInsideWorkspace, readPickedFile } from '../../src/main/attachments'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'

let dir: string
let outside: string
let db: Db
let repo: Repo
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'asi-ws-'))
  outside = mkdtempSync(join(tmpdir(), 'asi-out-'))
  db = await openDb(':memory:')
  repo = createRepo(db)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); db.close() })

test('file kinds', () => {
  expect(kindForFile('plan.md')).toBe('markdown')
  expect(kindForFile('fix.patch')).toBe('diff')
  expect(kindForFile('a.ts')).toBe('code')
  expect(kindForFile('shot.PNG')).toBe('image')
})

test('prompt fences content safely', () => {
  expect(attachmentPrompt('a.ts', 'let x = 1', 'look')).toBe("look\n\nI'm attaching a.ts:\n\n```\nlet x = 1\n```")
  expect(attachmentPrompt('a.md', 'has ``` inside', '')).toContain('~~~~')
})

test('agent-supplied paths must stay inside the workspace (including via symlinks)', async () => {
  writeFileSync(join(dir, 'notes.md'), '# hi')
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  mkdirSync(join(dir, 'sub'))
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'sub', 'link.txt'))
  expect(await readInsideWorkspace(join(dir, 'notes.md'), dir)).toBe('# hi')
  await expect(readInsideWorkspace(join(outside, 'secret.txt'), dir)).rejects.toThrow(/outside/)
  await expect(readInsideWorkspace(join(dir, 'sub', 'link.txt'), dir)).rejects.toThrow(/outside/)
  await expect(readInsideWorkspace(join(dir, '..', '..', 'etc', 'hosts'), dir)).rejects.toThrow()
})

test('size cap and binary files are refused for picked files', async () => {
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(300 * 1024))
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  await expect(readPickedFile(join(dir, 'big.txt'))).rejects.toThrow(/larger/)
  await expect(readPickedFile(join(dir, 'bin.dat'))).rejects.toThrow(/binary/)
})

test('loadAttachment returns inline bodies and reads path-only attachments from the workspace', async () => {
  const ws = await repo.workspaces.create({ name: 'w', path: dir })
  const f = await repo.friends.create({ harness: 'fake', displayName: 'Fake' })
  const c = await repo.chats.create({ workspaceId: ws.id, friendId: f.id })
  writeFileSync(join(dir, 'plan.md'), '# plan')
  const inline = await repo.messages.append({ chatId: c.id, role: 'agent', kind: 'attachment', body: { name: 'a.md', kind: 'markdown', body: '# inline' }, text: 'a.md' })
  const byPath = await repo.messages.append({ chatId: c.id, role: 'agent', kind: 'attachment', body: { name: 'plan.md', kind: 'markdown', path: join(dir, 'plan.md') }, text: 'plan.md' })
  expect(await loadAttachment(repo, inline.id)).toMatchObject({ text: '# inline', friendName: 'Fake', chatId: c.id })
  expect((await loadAttachment(repo, byPath.id)).text).toBe('# plan')
})
