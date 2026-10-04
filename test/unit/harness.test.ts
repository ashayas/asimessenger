import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import { createChatService } from '../../src/main/chat-service'
import { HarnessManager } from '../../src/harness/manager'
import { FakeAgent } from '../../src/harness/fake-agent'
import { EchoAgent } from '../../src/harness/echo-agent'

let db: Db
let repo: Repo
let manager: HarnessManager
let service: ReturnType<typeof createChatService>
let chatId: string
let agent: FakeAgent

const waitFor = async (fn: () => Promise<boolean>, ms = 3000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('timed out waiting')
}

beforeEach(async () => {
  db = await openDb(':memory:')
  repo = createRepo(db)
  const ingestor = createIngestor(repo, () => {})
  manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
  manager.register('fake', async () => (agent = new FakeAgent()))
  manager.register('echo', async () => new EchoAgent())
  service = createChatService({ repo, manager, ingestor, notify: () => {} })
  const ws = await repo.workspaces.create({ name: 'w', path: process.cwd() })
  const f = await repo.friends.create({ harness: 'fake', displayName: 'Fake' })
  chatId = (await repo.chats.create({ workspaceId: ws.id, friendId: f.id })).id
})
afterEach(async () => { await manager.disposeAll(); db.close() })

const kinds = async () => (await repo.messages.list(chatId)).map((m) => m.kind)

test('text turn is persisted, titled, and ends online', async () => {
  await service.send(chatId, 'hello fake')
  await waitFor(async () => (await repo.chats.get(chatId))!.status === 'online' && (await kinds()).includes('text') && (await repo.messages.list(chatId)).length === 2)
  const msgs = await repo.messages.list(chatId)
  expect(msgs.map((m) => [m.role, m.text])).toEqual([['user', 'hello fake'], ['agent', 'You said: hello fake']])
  expect((await repo.chats.get(chatId))!.title).toBe('hello fake')
  expect((await repo.chats.get(chatId))!.unreadCount).toBe(1)
})

test('tool events upsert one block and keep final output', async () => {
  await service.send(chatId, '/script tools')
  await waitFor(async () => (await repo.messages.list(chatId)).some((m) => m.text === 'Fixed the race in the refresh path.'))
  const tools = (await repo.messages.list(chatId)).filter((m) => m.kind === 'tool')
  expect(tools).toHaveLength(2)
  expect(tools[0]!.body).toMatchObject({ exit: 1, done: true, command: expect.stringContaining('vitest') })
})

test('permission card round trip: waiting -> allow -> agent continues', async () => {
  await service.send(chatId, '/script permission')
  await waitFor(async () => (await repo.chats.get(chatId))!.status === 'away')
  const card = (await repo.messages.list(chatId)).find((m) => m.kind === 'permission')!
  expect((await repo.chats.get(chatId))!.statusText).toBe('(⊙_⊙) waiting on u: rm -rf dist && pnpm build')
  await service.respond(chatId, (card.body as { reqId: string }).reqId, 'deny', 'too risky')
  await waitFor(async () => (await repo.messages.list(chatId)).some((m) => m.text === 'Permission handled.'))
  expect(agent.answers).toEqual([{ reqId: (card.body as { reqId: string }).reqId, answer: 'deny', reason: 'too risky' }])
  expect(((await repo.messages.get(card.id))!.body as { decision: string }).decision).toBe('deny')
})

test('question and attachment events are persisted and searchable', async () => {
  await service.send(chatId, '/script attachment')
  await waitFor(async () => (await kinds()).includes('attachment'))
  await waitFor(async () => (await repo.search.query('refresh-race')).some((h) => h.kind === 'attachment'))
  await service.send(chatId, '/script question')
  await waitFor(async () => (await kinds()).includes('question'))
  expect((await repo.chats.get(chatId))!.status).toBe('away')
})

test('interrupt stops a long turn and the chat returns online', async () => {
  await service.send(chatId, '/script long')
  await waitFor(async () => (await kinds()).includes('tool'))
  await service.interrupt(chatId)
  await waitFor(async () => (await repo.chats.get(chatId))!.statusText?.includes('stopped') === true)
  expect((await repo.chats.get(chatId))!.status).toBe('online')
})

test('unregistered harness reports an error message instead of crashing', async () => {
  const ws = (await repo.workspaces.list())[0]!
  const f = await repo.friends.create({ harness: 'claude', displayName: 'Claude' })
  const c = await repo.chats.create({ workspaceId: ws.id, friendId: f.id })
  await service.send(c.id, 'hi')
  const errs = (await repo.messages.list(c.id)).filter((m) => m.kind === 'error')
  expect(errs[0]!.text).toContain('no harness registered')
})

test('echo friend replies', async () => {
  const ws = (await repo.workspaces.list())[0]!
  const f = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
  const c = await repo.chats.create({ workspaceId: ws.id, friendId: f.id })
  await service.send(c.id, 'ping')
  await waitFor(async () => (await repo.messages.list(c.id)).some((m) => m.text === 'echo: ping'))
})

test('dangerous mode is refused unless the global switch AND the friend opt-in are on', async () => {
  await expect(service.setMode(chatId, 'dangerous')).rejects.toThrow(/turned off/)
  await service.setGlobalDangerous(true)
  await expect(service.setMode(chatId, 'dangerous')).rejects.toThrow(/this friend/i)
  const chat = (await repo.chats.get(chatId))!
  await service.setFriendDangerous(chat.friendId, true)
  await service.setMode(chatId, 'dangerous')
  expect((await repo.chats.get(chatId))!.mode).toBe('dangerous')
})

test('turning the global switch off drops dangerous chats to Ask and ends their sessions', async () => {
  const chat = (await repo.chats.get(chatId))!
  await service.setGlobalDangerous(true)
  await service.setFriendDangerous(chat.friendId, true)
  await service.setMode(chatId, 'dangerous')
  await service.send(chatId, 'start a session')
  await waitFor(async () => manager.isLive(chatId))
  await service.setGlobalDangerous(false)
  expect((await repo.chats.get(chatId))!.mode).toBe('ask')
  expect(manager.isLive(chatId)).toBe(false)
})

test('permission requests get a heuristic risk label', async () => {
  await service.send(chatId, '/script permission')
  await waitFor(async () => (await repo.messages.list(chatId)).some((m) => m.kind === 'permission'))
  const card = (await repo.messages.list(chatId)).find((m) => m.kind === 'permission')!
  expect((card.body as { risk: string }).risk).toBe('high') // rm -rf dist
})

test('new chats inherit the friend default mode; the mode is what the session starts with', async () => {
  const ws = (await repo.workspaces.list())[0]!
  const f = await repo.friends.create({ harness: 'fake', displayName: 'Planner', defaultMode: 'plan' })
  const c = await repo.chats.create({ workspaceId: ws.id, friendId: f.id })
  expect(c.mode).toBe('plan')
})

test('nudge interrupts a running turn, leaves a transcript line, and is rate limited', async () => {
  await service.send(chatId, '/script long')
  await waitFor(async () => (await kinds()).includes('tool'))
  expect(await service.nudge(chatId, 10_000)).toBe(true)
  await waitFor(async () => (await repo.chats.get(chatId))!.statusText?.includes('stopped') === true)
  const line = (await repo.messages.list(chatId)).find((m) => m.kind === 'nudge')!
  expect(line.text).toBe('You sent a nudge and stopped the agent.')
  expect(await service.nudge(chatId, 11_000)).toBe(false) // within 3s
  expect(await service.nudge(chatId, 14_000)).toBe(true)
  expect((await repo.messages.list(chatId)).filter((m) => m.kind === 'nudge')).toHaveLength(2)
})

test('attention events fire for replies, permissions and questions (not for your own interrupts)', async () => {
  const seen: { kind: string; text: string }[] = []
  const ing = createIngestor(repo, () => {}, (a) => seen.push({ kind: a.kind, text: a.text }))
  const mgr = new HarnessManager({ onEvent: (id, e) => void ing.ingest(id, e) })
  mgr.register('fake', async () => new FakeAgent())
  const svc = createChatService({ repo, manager: mgr, ingestor: ing, notify: () => {} })
  await svc.send(chatId, 'hello there')
  await waitFor(async () => seen.some((s) => s.kind === 'message'))
  expect(seen.find((s) => s.kind === 'message')!.text).toBe('You said: hello there')
  await svc.send(chatId, '/script permission')
  await waitFor(async () => seen.some((s) => s.kind === 'permission'))
  await svc.send(chatId, '/script question')
  await waitFor(async () => seen.some((s) => s.kind === 'question'))
  const before = seen.length
  await svc.send(chatId, '/script long')
  await waitFor(async () => (await repo.messages.list(chatId)).some((m) => m.kind === 'tool' && m.text?.includes('Long task')))
  await svc.interrupt(chatId)
  await new Promise((r) => setTimeout(r, 200))
  expect(seen.length).toBe(before)
  await mgr.disposeAll()
})

test('"!cmd" runs in the workspace, shows output and exit code, and never reaches the agent', async () => {
  const msg = (await service.send(chatId, '!echo hello-shell && pwd && exit 3'))!
  const done = await repo.messages.get(msg.id)
  const b = done!.body as { command: string; output: string; exit: number; done: boolean; cwd: string }
  expect(b).toMatchObject({ command: 'echo hello-shell && pwd && exit 3', exit: 3, done: true })
  expect(b.output).toContain('hello-shell')
  expect(b.output).toContain(b.cwd)
  expect(manager.isLive(chatId)).toBe(false) // no agent session was started
  expect((await repo.messages.list(chatId)).filter((m) => m.role === 'agent')).toHaveLength(0)
})

test('"/open" routes URLs to the browser and paths to the OS', async () => {
  const opened: string[] = []
  const svc = createChatService({ repo, manager, ingestor: createIngestor(repo, () => {}), notify: () => {}, opener: { url: (u) => opened.push(`url:${u}`), path: (p) => opened.push(`path:${p}`) } })
  await svc.send(chatId, '/open localhost:5173')
  await svc.send(chatId, '/open https://example.com/docs')
  await svc.send(chatId, '/open README.md')
  await svc.send(chatId, '/open javascript:alert(1)')
  expect(opened).toEqual(['url:http://localhost:5173', 'url:https://example.com/docs', `path:${process.cwd()}/README.md`]) // javascript:/file: style targets are refused
})
