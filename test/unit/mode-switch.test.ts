import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { EventHub } from '../../src/harness/emitter'
import { HarnessManager } from '../../src/harness/manager'
import { createChatService } from '../../src/main/chat-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import type { AgentEvent, AgentSession, UserTurn } from '../../src/shared/events'
import type { Mode } from '../../src/shared/models'

// An agent whose permission policy is read when it starts (like OpenCode's config or Antigravity's launch flags): the mock
// reports the policy it was launched with, so we can see whether a mode change really changed what the agent will do.
const MOCK = resolve('test/fixtures/mock-acp-agent.mjs')
const policyPreset = { command: process.execPath, args: [MOCK], env: (mode: Mode) => ({ MOCK_MODE: mode }) }

let db: Db
let repo: Repo
let manager: HarnessManager
let service: ReturnType<typeof createChatService>
let chatId: string
const said = async () => (await repo.messages.list(chatId)).filter((m) => m.role === 'agent' && m.kind === 'text').map((m) => m.text)

beforeEach(async () => {
  db = await openDb(':memory:')
  repo = createRepo(db)
  const ingestor = createIngestor(repo, () => {})
  manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e), onResumeId: (id, rid) => void repo.chats.setSession(id, rid) })
  manager.register('acp', acpFactory(policyPreset))
  service = createChatService({ repo, manager, ingestor, notify: () => {} })
  const ws = await repo.workspaces.create({ name: 'w', path: process.cwd() })
  const f = await repo.friends.create({ harness: 'acp', displayName: 'Mock', dangerousAllowed: true })
  chatId = (await repo.chats.create({ workspaceId: ws.id, friendId: f.id })).id
  await repo.settings.set('allowDangerous', true)
})
afterEach(async () => { await manager.disposeAll(); db.close() })

const policies = async () => (await said()).map((t) => /policy=(\w[\w-]*)/.exec(t ?? '')?.[1])
const waitForReplies = async (n: number) => { for (let i = 0; i < 200 && (await said()).length < n; i++) await new Promise((r) => setTimeout(r, 25)) }

test('a mode change for an agent that reads its policy at launch really changes it: ask, then dangerous, then ask again', async () => {
  await service.send(chatId, 'whatmode'); await waitForReplies(1)
  await service.setMode(chatId, 'dangerous'); await new Promise((r) => setTimeout(r, 100))
  await service.send(chatId, 'whatmode'); await waitForReplies(2)
  await service.setMode(chatId, 'ask'); await new Promise((r) => setTimeout(r, 100))
  await service.send(chatId, 'whatmode'); await waitForReplies(3)
  expect(await policies()).toEqual(['ask', 'dangerous', 'ask']) // going back to Ask matters most: it must not stay dangerous
  const pids = (await said()).map((t) => /pid=(\d+)/.exec(t ?? '')?.[1])
  expect(new Set(pids).size).toBe(3) // each mode is its own process
})

test('the conversation continues across the restart: the same agent session is resumed', async () => {
  await service.send(chatId, 'whatmode'); await waitForReplies(1)
  const first = (await repo.chats.get(chatId))!.harnessSessionId
  expect(first).toBeTruthy()
  await service.setMode(chatId, 'dangerous'); await new Promise((r) => setTimeout(r, 100))
  await service.send(chatId, 'whatmode'); await waitForReplies(2)
  expect((await repo.chats.get(chatId))!.harnessSessionId).toBe(first)
})

test('switching mode while the agent is mid-turn does not kill the turn; the switch happens when it ends', async () => {
  const events: AgentEvent[] = []
  let restarts = 0
  class Policy implements AgentSession {
    hub = new EventHub(); subscribe = this.hub.subscribe
    restartOnModeChange = true
    busy = false
    send(_t: UserTurn) { this.busy = true; this.hub.emit({ t: 'status', phase: 'thinking' }) }
    async interrupt() {}
    respond() {}
    setMode() {}
    async dispose() { restarts++ }
    finish() { this.busy = false; this.hub.emit({ t: 'turn_end', reason: 'done' }) }
  }
  const m = new HarnessManager({ onEvent: (_id, e) => events.push(e) })
  let made: Policy | null = null
  m.register('echo', async () => (made = new Policy()))
  const chat = { id: 'c', harnessSessionId: null, mode: 'ask' } as never
  const friend = { id: 'f', harness: 'echo', defaultMode: 'ask' } as never
  await m.send(chat, friend, '/tmp', { text: 'work' })
  m.setMode('c', 'dangerous')
  await new Promise((r) => setTimeout(r, 20))
  expect(restarts).toBe(0) // still working: left alone
  expect(m.isLive('c')).toBe(true)
  made!.finish()
  await new Promise((r) => setTimeout(r, 20))
  expect(restarts).toBe(1)
  expect(m.isLive('c')).toBe(false) // the next message starts a fresh session in the new mode
  m.setMode('c', 'ask') // nothing live: harmless
})

test('agents that switch live (Claude, Codex, Pi) are never restarted for a mode change', async () => {
  let disposed = 0
  class Live implements AgentSession {
    hub = new EventHub(); subscribe = this.hub.subscribe
    modes: string[] = []
    send() {}
    async interrupt() {}
    respond() {}
    setMode(mode: Mode) { this.modes.push(mode) }
    async dispose() { disposed++ }
  }
  const m = new HarnessManager({ onEvent: () => {} })
  let s: Live | null = null
  m.register('echo', async () => (s = new Live()))
  await m.send({ id: 'c', harnessSessionId: null, mode: 'ask' } as never, { id: 'f', harness: 'echo', defaultMode: 'ask' } as never, '/tmp', { text: 'hi' })
  m.setMode('c', 'dangerous'); m.setMode('c', 'plan')
  expect(s!.modes).toEqual(['dangerous', 'plan'])
  expect(disposed).toBe(0)
  expect(m.isLive('c')).toBe(true)
})

test('revoking a session during startup disposes it before a prompt can reach the process', async () => {
  let ready!: () => void
  const gate = new Promise<void>((r) => { ready = r })
  let disposed = false, sent = false
  const m = new HarnessManager({ onEvent: () => {} })
  m.register('echo', async () => {
    await gate
    return { subscribe: () => () => {}, send: () => { sent = true }, interrupt: async () => {}, respond() {}, setMode() {}, dispose: async () => { disposed = true } }
  })
  const sending = m.send({ id: 'c', mode: 'dangerous' } as never, { harness: 'echo' } as never, '/tmp', { text: 'work' })
  const rejected = expect(sending).rejects.toThrow(/cancelled/)
  await Promise.resolve() // enter the factory
  const stopping = m.dispose('c')
  ready()
  await Promise.all([rejected, stopping])
  expect(sent).toBe(false)
  expect(disposed).toBe(true)
  expect(m.isLive('c')).toBe(false)
})
