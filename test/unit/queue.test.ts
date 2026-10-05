import { afterEach, beforeEach, expect, test } from 'vitest'
import { EventHub } from '../../src/harness/emitter'
import { HarnessManager } from '../../src/harness/manager'
import { createChatService } from '../../src/main/chat-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import type { AgentSession, UserTurn } from '../../src/shared/events'

/** A session the test drives by hand: it works until told how the turn ends. */
class Manual implements AgentSession {
  hub = new EventHub()
  subscribe = this.hub.subscribe
  sent: string[] = []
  interrupted = 0
  send(t: UserTurn) { this.sent.push(t.text); this.hub.emit({ t: 'status', phase: 'thinking' }) }
  async interrupt() { this.interrupted++; this.end('interrupted') }
  respond() {}
  setMode() {}
  async dispose() {}
  end(reason: 'done' | 'interrupted' | 'error') { this.hub.emit({ t: 'turn_end', reason, error: reason === 'error' ? 'boom' : undefined }) }
}

let db: Db
let repo: Repo
let manager: HarnessManager
let service: ReturnType<typeof createChatService>
let agent: Manual
let chatId: string
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)) }
const sent = () => agent.sent

beforeEach(async () => {
  db = await openDb(':memory:')
  repo = createRepo(db)
  const ref: { s: ReturnType<typeof createChatService> | null } = { s: null }
  const ingestor = createIngestor(repo, () => {}, undefined, undefined, (id, reason) => void ref.s?.onTurnEnd(id, reason))
  manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
  manager.register('echo', async () => (agent = new Manual()))
  service = createChatService({ repo, manager, ingestor, notify: () => {} })
  ref.s = service
  const ws = await repo.workspaces.create({ name: 'w', path: process.cwd() })
  const f = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
  chatId = (await repo.chats.create({ workspaceId: ws.id, friendId: f.id })).id
})
afterEach(async () => { await manager.disposeAll(); db.close() })

test('an idle agent just gets the prompt', async () => {
  expect(await service.queuePrompt(chatId, 'hello')).toEqual({ queued: false })
  await settle()
  expect(sent()).toEqual(['hello'])
  expect(service.getQueued(chatId)).toBeNull()
})

test('while the agent works the prompt is held, and it goes out when the turn finishes', async () => {
  await service.send(chatId, 'first'); await settle()
  expect(await service.queuePrompt(chatId, 'second')).toEqual({ queued: true })
  expect(service.getQueued(chatId)).toEqual({ text: 'second', quote: undefined, held: false })
  expect(sent()).toEqual(['first'])
  agent.end('done'); await settle()
  expect(sent()).toEqual(['first', 'second'])
  expect(service.getQueued(chatId)).toBeNull()
})

test('queuing again adds to what is held, so nothing is lost', async () => {
  await service.send(chatId, 'first'); await settle()
  await service.queuePrompt(chatId, 'second'); await service.queuePrompt(chatId, 'third')
  agent.end('done'); await settle()
  expect(sent()[1]).toBe('second\n\nthird')
})

test('a blank prompt is ignored', async () => {
  expect(await service.queuePrompt(chatId, '   ')).toEqual({ queued: false })
  expect(service.getQueued(chatId)).toBeNull()
  expect(await repo.messages.list(chatId)).toHaveLength(0) // nothing was said to anyone
})

test('if the agent fails, the held prompt is not sent and stays for you', async () => {
  await service.send(chatId, 'first'); await settle()
  await service.queuePrompt(chatId, 'second')
  agent.end('error'); await settle()
  expect(sent()).toEqual(['first'])
  expect(service.getQueued(chatId)).toMatchObject({ text: 'second', held: true })
})

test('if you stop the agent, the same: held, not sent', async () => {
  await service.send(chatId, 'first'); await settle()
  await service.queuePrompt(chatId, 'second')
  await service.interrupt(chatId); await settle()
  expect(sent()).toEqual(['first'])
  expect(service.getQueued(chatId)!.held).toBe(true)
})

test('Send now stops a working agent and sends; on a held prompt it just sends', async () => {
  await service.send(chatId, 'first'); await settle()
  await service.queuePrompt(chatId, 'second')
  await service.sendQueuedNow(chatId); await settle()
  expect(agent.interrupted).toBe(1)
  expect(sent()).toEqual(['first', 'second'])
  expect(service.getQueued(chatId)).toBeNull()
  await service.sendQueuedNow(chatId) // nothing held: harmless
  expect(sent()).toHaveLength(2)
})

test('taking the prompt back returns its text and clears the slot', async () => {
  await service.send(chatId, 'first'); await settle()
  await service.queuePrompt(chatId, 'second')
  expect(service.takeQueued(chatId)).toBe('second')
  expect(service.getQueued(chatId)).toBeNull()
  expect(service.takeQueued(chatId)).toBeNull()
  agent.end('done'); await settle()
  expect(sent()).toEqual(['first']) // dismissed, so nothing follows
})

test('each chat has its own slot, and deleting a chat drops its held prompt', async () => {
  const ws = (await repo.workspaces.list())[0]!
  const f = (await repo.friends.list())[0]!
  const other = (await repo.chats.create({ workspaceId: ws.id, friendId: f.id })).id
  await service.send(chatId, 'first'); await settle()
  await service.queuePrompt(chatId, 'second')
  expect(service.getQueued(other)).toBeNull()
  await service.deleteChat(chatId)
  expect(service.getQueued(chatId)).toBeNull()
})

test('a nudge is a transcript line only: nothing about it is ever sent to the agent, and a pending question just goes unanswered', async () => {
  await service.send(chatId, 'first'); await settle()
  const answer = service.askUser(chatId, 'which fruit?', ['apple', 'pear'])
  await settle()
  const before = sent().length
  expect(await service.nudge(chatId, 1_000_000)).toBe(true)
  await settle()
  expect(agent.interrupted).toBe(1)
  expect(sent()).toHaveLength(before) // no new turn, no text, nothing that mentions a nudge
  expect(await answer).toBe('The human did not answer.')
  expect(await answer).not.toMatch(/nudge/i)
  const line = (await repo.messages.list(chatId)).find((m) => m.kind === 'nudge')!
  expect(line.role).toBe('system')
  expect(line.text).toMatch(/You sent a nudge/) // it is still in the transcript for you
  // and the next thing you say does not carry it along
  await service.send(chatId, 'carry on'); await settle()
  expect(sent().at(-1)).toBe('carry on')
})
