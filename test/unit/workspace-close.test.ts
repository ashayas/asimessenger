import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { EventHub } from '../../src/harness/emitter'
import { HarnessManager } from '../../src/harness/manager'
import { adoptSession } from '../../src/main/adopt'
import { createChatService } from '../../src/main/chat-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import { searchAll } from '../../src/main/search'
import { createWorktrees } from '../../src/main/worktrees'
import type { AgentSession, UserTurn } from '../../src/shared/events'

class Manual implements AgentSession {
  hub = new EventHub()
  subscribe = this.hub.subscribe
  disposed = false
  send(_t: UserTurn) { this.hub.emit({ t: 'status', phase: 'thinking' }) }
  async interrupt() {}
  respond() {}
  setMode() {}
  async dispose() { this.disposed = true }
}

let db: Db
let repo: Repo
let manager: HarnessManager
let service: ReturnType<typeof createChatService>
let friendId: string
let base: string
const sessions: Manual[] = []
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)) }
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'asi-wsclose-')))
  sessions.length = 0
  db = await openDb(':memory:')
  repo = createRepo(db)
  const ingestor = createIngestor(repo, () => {})
  manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
  manager.register('echo', async () => { const s = new Manual(); sessions.push(s); return s })
  service = createChatService({ repo, manager, ingestor, notify: () => {}, worktrees: createWorktrees({ dir: join(base, 'worktrees') }) })
  friendId = (await repo.friends.create({ harness: 'echo', displayName: 'Echo' })).id
})
afterEach(async () => { await manager.disposeAll(); db.close(); rmSync(base, { recursive: true, force: true }) })

test('closing hides a workspace from the list but keeps it, its slot and its chats; reopening brings it all back', async () => {
  const a = await repo.workspaces.create({ name: 'honeycomb', path: '/tmp/h' })
  const b = await repo.workspaces.create({ name: 'fantasy', path: '/tmp/f' })
  const chat = await repo.chats.create({ workspaceId: a.id, friendId, title: 'auth refactor' })
  await repo.workspaces.close(a.id)
  expect((await repo.workspaces.list()).map((w) => w.name)).toEqual(['fantasy'])
  expect((await repo.workspaces.listClosed()).map((w) => w.name)).toEqual(['honeycomb'])
  expect((await repo.workspaces.get(a.id))!.closedAt).not.toBeNull() // still loadable, so its chats still resolve
  expect((await repo.chats.list({ workspaceId: a.id })).map((c) => c.title)).toEqual(['auth refactor'])
  await repo.workspaces.reopen(a.id)
  expect((await repo.workspaces.list()).map((w) => w.name)).toEqual(['honeycomb', 'fantasy']) // slots 1 and 2 as before
  expect((await repo.workspaces.get(a.id))!.slot).toBe(1)
  expect((await repo.chats.get(chat.id))!.title).toBe('auth refactor')
  void b
})

test('a closed workspace gives up its ⌘ slot, and reopening takes the next free one when it was reused', async () => {
  const a = await repo.workspaces.create({ name: 'a', path: '/tmp/a' }) // slot 1
  await repo.workspaces.close(a.id)
  const c = await repo.workspaces.create({ name: 'c', path: '/tmp/c' })
  expect(c.slot).toBe(1) // the closed one's slot is free for a new workspace
  await repo.workspaces.reopen(a.id)
  expect((await repo.workspaces.get(a.id))!.slot).toBe(2) // slot 1 is taken now
})

test('findByPath finds a workspace for a folder whether it is open or closed', async () => {
  const a = await repo.workspaces.create({ name: 'a', path: '/tmp/a' })
  expect((await repo.workspaces.findByPath('/tmp/a'))!.id).toBe(a.id)
  await repo.workspaces.close(a.id)
  expect((await repo.workspaces.findByPath('/tmp/a'))!.closedAt).not.toBeNull()
  expect(await repo.workspaces.findByPath('/tmp/none')).toBeNull()
})

test('closing stops the workspace’s agents and cancels held prompts, but keeps every chat and message', async () => {
  const a = await repo.workspaces.create({ name: 'honeycomb', path: process.cwd() })
  const c1 = await repo.chats.create({ workspaceId: a.id, friendId, title: 'one' })
  const c2 = await repo.chats.create({ workspaceId: a.id, friendId, title: 'two' })
  await service.send(c1.id, 'work'); await service.send(c2.id, 'work'); await settle()
  expect(await service.workingIn(a.id)).toBe(2)
  await service.queuePrompt(c1.id, 'later')
  const ids = await service.closeWorkspace(a.id)
  expect(ids.sort()).toEqual([c1.id, c2.id].sort())
  expect(sessions.every((s) => s.disposed)).toBe(true)
  expect(service.getQueued(c1.id)).toBeNull()
  expect(await service.workingIn(a.id)).toBe(0) // nothing is left "busy" in a workspace nobody is running
  expect((await repo.messages.list(c1.id)).some((m) => m.text === 'work')).toBe(true)
  expect(await repo.workspaces.list()).toHaveLength(0)
})

test('chats in a closed workspace do not count toward unread or show up in search', async () => {
  const { totalUnread } = await import('../../src/main/notifications').catch(() => ({ totalUnread: null }))
  void totalUnread
  const a = await repo.workspaces.create({ name: 'honeycomb', path: '/tmp/h' })
  const b = await repo.workspaces.create({ name: 'fantasy', path: '/tmp/f' })
  const ca = await repo.chats.create({ workspaceId: a.id, friendId, title: 'zebra refactor' })
  await repo.chats.create({ workspaceId: b.id, friendId, title: 'zebra outline' })
  expect((await searchAll(repo, 'zebra')).map((r) => r.title).sort()).toEqual(['zebra outline', 'zebra refactor'])
  await repo.workspaces.close(a.id)
  expect((await searchAll(repo, 'zebra')).map((r) => r.title)).toEqual(['zebra outline'])
  await repo.workspaces.reopen(a.id)
  expect((await searchAll(repo, 'zebra')).map((r) => r.title)).toContain('zebra refactor')
  void ca
})

test('bringing in an outside session for a closed workspace reopens that workspace instead of making a second', async () => {
  const f = await repo.friends.create({ harness: 'claude', displayName: 'Claude Code' })
  void f
  const a = await repo.workspaces.create({ name: 'honeycomb', path: '/tmp/honeycomb' })
  await repo.workspaces.close(a.id)
  const chatId = await adoptSession(repo, { type: 'adopt', harness: 'claude', sessionId: 's1', cwd: '/tmp/honeycomb/api', title: 'pagination' })
  expect((await repo.chats.get(chatId))!.workspaceId).toBe(a.id)
  expect((await repo.workspaces.list()).map((w) => w.name)).toEqual(['honeycomb'])
  expect(await repo.workspaces.listClosed()).toHaveLength(0)
})

test('deleting a workspace removes its chats and clean worktrees, keeps dirty ones, and leaves other workspaces alone', async () => {
  const repoDir = join(base, 'honeycomb'); mkdirSync(repoDir)
  sh(base, 'init', '-q', repoDir)
  writeFileSync(join(repoDir, 'README.md'), 'hi\n'); sh(repoDir, 'add', '-A'); sh(repoDir, 'commit', '-qm', 'init')
  const a = await repo.workspaces.create({ name: 'honeycomb', path: repoDir })
  const other = await repo.workspaces.create({ name: 'other', path: '/tmp/other' })
  const keep = await repo.chats.create({ workspaceId: other.id, friendId, title: 'safe' })
  const clean = await service.newIsolatedChat(a.id, friendId)
  const dirty = await service.newIsolatedChat(a.id, friendId)
  writeFileSync(join(dirty.worktreePath!, 'wip.txt'), 'precious')
  await repo.workspaces.close(a.id)
  const r = await service.deleteWorkspace(a.id)
  expect(r.chats).toBe(2)
  expect(r.notes).toHaveLength(1)
  expect(existsSync(clean.worktreePath!)).toBe(false)
  expect(existsSync(join(dirty.worktreePath!, 'wip.txt'))).toBe(true)
  expect(await repo.workspaces.get(a.id)).toBeNull()
  expect((await repo.chats.get(keep.id))!.title).toBe('safe')
})
