import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { EchoAgent } from '../../src/harness/echo-agent'
import { HarnessManager } from '../../src/harness/manager'
import { loadAttachment } from '../../src/main/attachments'
import { createChatService } from '../../src/main/chat-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import { createWorktrees } from '../../src/main/worktrees'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let base: string
let repoDir: string
let db: Db
let repo: Repo
let manager: HarnessManager
let service: ReturnType<typeof createChatService>
let wsId: string
let friendId: string
const cwds: string[] = []

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'asi-iso-')))
  repoDir = join(base, 'honeycomb'); mkdirSync(repoDir)
  sh(base, 'init', '-q', repoDir)
  writeFileSync(join(repoDir, 'README.md'), '# hi\n'); sh(repoDir, 'add', '-A'); sh(repoDir, 'commit', '-qm', 'init')
  cwds.length = 0
  db = await openDb(':memory:')
  repo = createRepo(db)
  const ingestor = createIngestor(repo, () => {})
  manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
  manager.register('echo', async (ctx) => { cwds.push(ctx.cwd); return new EchoAgent() })
  service = createChatService({ repo, manager, ingestor, notify: () => {}, worktrees: createWorktrees({ dir: join(base, 'worktrees') }) })
  wsId = (await repo.workspaces.create({ name: 'honeycomb', path: repoDir })).id
  friendId = (await repo.friends.create({ harness: 'echo', displayName: 'Echo' })).id
})
afterEach(async () => { await manager.disposeAll(); db.close(); rmSync(base, { recursive: true, force: true }) })

test('an isolated chat gets its own branch and folder, and its agent runs there, not in the repo', async () => {
  const c = await service.newIsolatedChat(wsId, friendId)
  expect(c.branch).toMatch(/^asi\//)
  expect(c.worktreePath!.startsWith(join(base, 'worktrees', 'honeycomb'))).toBe(true)
  expect(existsSync(join(c.worktreePath!, 'README.md'))).toBe(true)
  await service.send(c.id, 'hello')
  expect(cwds).toEqual([c.worktreePath])
  // a plain chat in the same workspace still uses the workspace folder
  const plain = await repo.chats.create({ workspaceId: wsId, friendId })
  await service.send(plain.id, 'hello')
  expect(cwds[1]).toBe(repoDir)
})

test('three isolated chats in one repo never share a folder or branch', async () => {
  const cs = [await service.newIsolatedChat(wsId, friendId), await service.newIsolatedChat(wsId, friendId), await service.newIsolatedChat(wsId, friendId)]
  expect(new Set(cs.map((c) => c.branch)).size).toBe(3)
  expect(new Set(cs.map((c) => c.worktreePath)).size).toBe(3)
  expect(sh(repoDir, 'worktree', 'list').split('\n')).toHaveLength(4)
})

test('! commands, /open and pictures are scoped to the chat’s worktree', async () => {
  const c = await service.newIsolatedChat(wsId, friendId)
  await service.runShell(c.id, 'pwd')
  const shell = (await repo.messages.list(c.id)).find((m) => m.kind === 'tool')!
  expect((shell.body as { output: string }).output.trim()).toBe(c.worktreePath)
  const saved = await service.saveImage(c.id, 'shot.png', PNG)
  expect(saved.startsWith(join(c.worktreePath!, '.attachments'))).toBe(true)
  await service.sendFiles(c.id, [saved])
  const att = (await repo.messages.list(c.id)).find((m) => m.kind === 'attachment')!
  expect((await loadAttachment(repo, att.id)).text).toMatch(/^data:image\/png;base64,/) // the viewer can read it
  expect(sh(c.worktreePath!, 'status', '--porcelain')).toBe('') // pictures never make the worktree "dirty"
})

test('a folder that is not a repo says so, and nothing is created', async () => {
  const plain = join(base, 'plain'); mkdirSync(plain)
  const ws = await repo.workspaces.create({ name: 'plain', path: plain })
  await expect(service.newIsolatedChat(ws.id, friendId)).rejects.toThrow(/not a git repository/)
  expect(await repo.chats.list({ workspaceId: ws.id })).toHaveLength(0)
})

test('deleting a clean isolated chat removes its worktree and branch', async () => {
  const c = await service.newIsolatedChat(wsId, friendId)
  await service.send(c.id, 'hello')
  expect(await service.worktreeInfo(c.id)).toMatchObject({ isolated: true, branch: c.branch, dirty: 0 })
  expect(await service.deleteChat(c.id)).toEqual({ note: null })
  expect(existsSync(c.worktreePath!)).toBe(false)
  expect(sh(repoDir, 'branch', '--list', c.branch!)).toBe('')
  expect(await repo.chats.get(c.id)).toBeNull()
})

test('deleting a chat with uncommitted work keeps the folder and tells you', async () => {
  const c = await service.newIsolatedChat(wsId, friendId)
  writeFileSync(join(c.worktreePath!, 'wip.txt'), 'precious')
  expect((await service.worktreeInfo(c.id)).dirty).toBe(1)
  const r = await service.deleteChat(c.id)
  expect(r.note).toMatch(/uncommitted/)
  expect(existsSync(join(c.worktreePath!, 'wip.txt'))).toBe(true)
  expect(await repo.chats.get(c.id)).toBeNull()
})

test('deleting a plain chat leaves the repo alone; delete-all tidies only what is safe', async () => {
  const plain = await repo.chats.create({ workspaceId: wsId, friendId })
  expect(await service.worktreeInfo(plain.id)).toMatchObject({ isolated: false })
  const clean = await service.newIsolatedChat(wsId, friendId)
  const dirty = await service.newIsolatedChat(wsId, friendId)
  writeFileSync(join(dirty.worktreePath!, 'wip.txt'), 'x')
  const r = await service.deleteAllChats()
  expect(r.count).toBe(3)
  expect(r.kept).toHaveLength(1)
  expect(existsSync(clean.worktreePath!)).toBe(false)
  expect(existsSync(dirty.worktreePath!)).toBe(true)
})
