import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, migrate, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'

let db: Db
let repo: Repo
beforeEach(async () => {
  db = await openDb(':memory:')
  repo = createRepo(db)
})
afterEach(() => db.close())

async function seed() {
  const ws = await repo.workspaces.create({ name: 'honeycomb', path: '/tmp/hc', slot: 1 })
  const friend = await repo.friends.create({ harness: 'claude', displayName: 'Claude Code', command: 'claude' })
  const chat = await repo.chats.create({ workspaceId: ws.id, friendId: friend.id, title: 'auth-refactor' })
  return { ws, friend, chat }
}

test('migrations are idempotent', async () => {
  const n = await migrate(db)
  expect(await migrate(db)).toBe(n)
  const v = await db.execute('SELECT COUNT(*) AS c FROM schema_version')
  expect(Number(v.rows[0]!['c'])).toBe(n)
})

test('crud: workspace, friend, chat, messages with unread tracking', async () => {
  const { chat } = await seed()
  await repo.messages.append({ chatId: chat.id, role: 'user', kind: 'text', body: { t: 'hi' }, text: 'hi' })
  await repo.messages.append({ chatId: chat.id, role: 'agent', kind: 'text', body: { t: 'hello' }, text: 'hello' })
  expect((await repo.chats.get(chat.id))!.unreadCount).toBe(1)
  expect((await repo.messages.list(chat.id)).map((m) => m.text)).toEqual(['hi', 'hello'])
  await repo.chats.markRead(chat.id)
  expect((await repo.chats.get(chat.id))!.unreadCount).toBe(0)
})

test('full-text search finds chats, messages, attachments and friends', async () => {
  const { ws, chat } = await seed()
  const m = await repo.messages.append({ chatId: chat.id, role: 'agent', kind: 'text', body: {}, text: 'should the refresh lock be per tab or global?' })
  await repo.attachments.add({ messageId: m.id, kind: 'markdown', name: 'refresh-race.md', body: '# Root cause of the race' })
  const hits = await repo.search.query('refresh lock')
  expect(hits.map((h) => h.kind)).toContain('message')
  expect((await repo.search.query('refresh-race'))[0]!.kind).toBe('attachment')
  expect((await repo.search.query('auth'))[0]).toMatchObject({ kind: 'chat', workspaceId: ws.id })
  expect((await repo.search.query('claud'))[0]!.kind).toBe('friend')
  expect(await repo.search.query('   ')).toEqual([])
})

test('renaming and deleting keep the search index in sync', async () => {
  const { chat } = await seed()
  await repo.chats.rename(chat.id, 'billing-fix')
  expect(await repo.search.query('auth')).toHaveLength(0)
  expect((await repo.search.query('billing'))[0]!.refId).toBe(chat.id)
  await repo.chats.remove(chat.id)
  expect(await repo.search.query('billing')).toHaveLength(0)
})

test('cascade: removing a friend removes its chats and messages', async () => {
  const { friend, chat } = await seed()
  await repo.messages.append({ chatId: chat.id, role: 'user', kind: 'text', body: {}, text: 'zebra' })
  await repo.friends.remove(friend.id)
  expect(await repo.chats.get(chat.id)).toBeNull()
  expect(await repo.search.query('zebra')).toHaveLength(0)
})

test('labels and settings round-trip; file db persists across reopen', async () => {
  const { chat } = await seed()
  const l = await repo.labels.create('infra', '#6b3fa0')
  await repo.labels.setForChat(chat.id, [l.id])
  expect((await repo.labels.forChat(chat.id)).map((x) => x.name)).toEqual(['infra'])
  await repo.settings.set('theme', 'live8')
  expect(await repo.settings.get('theme', 'x')).toBe('live8')
  expect(await repo.settings.get('missing', 42)).toBe(42)

  const dir = mkdtempSync(join(tmpdir(), 'asi-db-'))
  try {
    const f = join(dir, 'nested', 'asi.db')
    const a = await openDb(f)
    await createRepo(a).settings.set('k', 1)
    a.close()
    const b = await openDb(f)
    expect(await createRepo(b).settings.get('k', 0)).toBe(1)
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspaces take the next free ⌘ slot, and null opts out', async () => {
  const a = await repo.workspaces.create({ name: 'a', path: '/a' })
  const b = await repo.workspaces.create({ name: 'b', path: '/b' })
  const c = await repo.workspaces.create({ name: 'c', path: '/c', slot: null })
  expect([a.slot, b.slot, c.slot]).toEqual([1, 2, null])
  await repo.workspaces.remove(a.id)
  expect((await repo.workspaces.create({ name: 'd', path: '/d' })).slot).toBe(1)
  expect((await repo.workspaces.list()).map((w) => w.name)).toEqual(['d', 'b', 'c'])
})

test('labels: friend and chat assignments, bulk listing, rename and cascade on delete', async () => {
  const { friend, chat } = await seed()
  const infra = await repo.labels.create('infra', '#6b3fa0')
  const urgent = await repo.labels.create('urgent')
  await repo.labels.setForFriend(friend.id, [infra.id])
  await repo.labels.setForChat(chat.id, [infra.id, urgent.id])
  expect((await repo.labels.forFriend(friend.id)).map((l) => l.name)).toEqual(['infra'])
  const a = await repo.labels.assignments()
  expect(a.friends).toEqual([{ friendId: friend.id, labelId: infra.id }])
  expect(a.chats.map((c) => c.labelId).sort()).toEqual([infra.id, urgent.id].sort())
  await repo.labels.rename(urgent.id, 'p0')
  expect((await repo.labels.forChat(chat.id)).map((l) => l.name)).toEqual(['infra', 'p0'])
  await repo.labels.remove(infra.id)
  expect((await repo.labels.assignments()).friends).toEqual([])
  await expect(repo.labels.create('p0')).rejects.toThrow() // names are unique
})

test('drawings are indexed once per path and searchable by title', async () => {
  const { ws } = await seed()
  const a = await repo.drawings.upsert({ workspaceId: ws.id, path: '/hc/.drawings/auth-flow.excalidraw', title: 'auth-flow.excalidraw' })
  const b = await repo.drawings.upsert({ workspaceId: ws.id, path: '/hc/.drawings/auth-flow.excalidraw', title: 'auth-flow.excalidraw' })
  expect(b).toBe(a)
  expect((await repo.drawings.list(ws.id)).map((d) => d.title)).toEqual(['auth-flow.excalidraw'])
  expect((await repo.search.query('auth-flow'))[0]).toMatchObject({ kind: 'drawing', refId: a })
})

test('export contains chats with messages; delete-all keeps friends and workspaces; lettering is settable', async () => {
  const { ws, friend, chat } = await seed()
  await repo.messages.append({ chatId: chat.id, role: 'user', kind: 'text', body: { text: 'hi' }, text: 'hi' })
  await repo.messages.append({ chatId: chat.id, role: 'agent', kind: 'text', body: { text: 'hello' }, text: 'hello' })
  const dump = await repo.data.exportAll()
  expect(dump.chats).toEqual([expect.objectContaining({ title: 'auth-refactor', messages: [expect.objectContaining({ role: 'user', text: 'hi' }), expect.objectContaining({ role: 'agent', text: 'hello' })] })])
  expect(JSON.stringify(dump)).not.toContain('secret') // no credentials in an export
  await repo.friends.setLettering(friend.id, 'plain')
  expect((await repo.friends.get(friend.id))!.letteringStyle).toBe('plain')
  expect(await repo.data.deleteAllChats()).toBe(1)
  expect(await repo.chats.list()).toEqual([])
  expect(await repo.search.query('hello')).toEqual([]) // the search index followed
  expect((await repo.workspaces.get(ws.id))!.name).toBe('honeycomb')
  expect(await repo.friends.list()).toHaveLength(1)
})
