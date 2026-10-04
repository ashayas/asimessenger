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
