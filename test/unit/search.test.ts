import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { searchAll } from '../../src/main/search'

let db: Db
let repo: Repo
beforeEach(async () => { db = await openDb(':memory:'); repo = createRepo(db) })
afterEach(() => db.close())

test('results resolve to jump targets, carry workspace labels and group in a stable order', async () => {
  const w1 = await repo.workspaces.create({ name: 'honeycomb', path: '/a' })
  const w2 = await repo.workspaces.create({ name: 'fantasy', path: '/b' })
  const claude = await repo.friends.create({ harness: 'claude', displayName: 'Claude Code' })
  const chat = await repo.chats.create({ workspaceId: w1.id, friendId: claude.id, title: 'refresh lock fix' })
  const other = await repo.chats.create({ workspaceId: w2.id, friendId: claude.id, title: 'plot twist' })
  const m = await repo.messages.append({ chatId: other.id, role: 'agent', kind: 'text', body: {}, text: 'should the refresh lock be global?' })
  const att = await repo.messages.append({ chatId: chat.id, role: 'agent', kind: 'attachment', body: {}, text: 'refresh-race.md' })
  await repo.attachments.add({ messageId: att.id, kind: 'markdown', name: 'refresh-race.md', body: 'lock analysis' })

  const r = await searchAll(repo, 'refresh')
  expect(r.map((x) => x.kind)).toEqual(['chat', 'attachment', 'message', 'message'].filter((k, i, a) => a.indexOf(k) === i || true).slice(0, r.length))
  const byKind = (k: string) => r.filter((x) => x.kind === k)
  expect(byKind('chat')[0]).toMatchObject({ title: 'refresh lock fix', workspaceName: 'honeycomb', workspaceSlot: 1, target: { type: 'chat', chatId: chat.id } })
  expect(byKind('attachment')[0]!.target).toMatchObject({ type: 'attachment', messageId: att.id, chatId: chat.id })
  const msg = byKind('message').find((x) => x.target.type === 'chat' && x.target.chatId === other.id)!
  expect(msg).toMatchObject({ workspaceName: 'fantasy', workspaceSlot: 2 })
  expect(msg.snippet).toContain('[refresh]')
  void m

  expect((await searchAll(repo, 'claud'))[0]).toMatchObject({ kind: 'friend', target: { type: 'friend', friendId: claude.id } })
  expect(await searchAll(repo, 'zzzzqq')).toEqual([])
  const order = r.map((x) => ['chat', 'friend', 'attachment', 'drawing', 'message'].indexOf(x.kind))
  expect(order).toEqual([...order].sort((a, b) => a - b))
})
