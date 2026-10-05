import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { CodexSession } from '../../src/harness/codex/session'
import { EchoAgent } from '../../src/harness/echo-agent'
import { HarnessManager } from '../../src/harness/manager'
import { createBrain } from '../../src/asi/brain'
import { llmTitle } from '../../src/asi/decider'
import { createTitler } from '../../src/asi/titler'
import { createChatService } from '../../src/main/chat-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import { createSecrets } from '../../src/main/secrets'
import { canReplaceTitle, cleanTitle, ruleTitle } from '../../src/shared/title'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import { collect, friendFor } from './helpers'

describe('title helpers', () => {
  test('ruleTitle drops filler, keeps the first sentence, cuts on a word boundary', () => {
    expect(ruleTitle('hey, can you please fix the flaky session refresh test? it fails on CI')).toBe('fix the flaky session refresh test')
    expect(ruleTitle('Ok so I want you to add rate limiting to the api. Use redis.')).toBe('add rate limiting to the api')
    expect(ruleTitle("let's migrate the build to vite 7 and drop webpack entirely, then update the docs")).toBe('migrate the build to vite 7 and drop…')
    expect(ruleTitle('hello there')).toBe('hello there') // a greeting alone is not stripped to nothing
    expect(ruleTitle('```ts\nconst a = 1\n```\nwhy does this fail')).toBe('const a = 1')
    expect(ruleTitle('   \n  ')).toBe('')
    expect(ruleTitle('x'.repeat(80)).length).toBeLessThanOrEqual(42)
  })
  test('cleanTitle tidies model and agent titles', () => {
    expect(cleanTitle('Title: "Fix flaky session test."\nBecause…')).toBe('Fix flaky session test')
    expect(cleanTitle('**Refactor auth**')).toBe('Refactor auth')
    expect(cleanTitle('a'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
  test('a better source replaces a worse one, nothing replaces your own title', () => {
    expect(canReplaceTitle('default', 'rule')).toBe(true)
    expect(canReplaceTitle('rule', 'model')).toBe(true)
    expect(canReplaceTitle('model', 'agent')).toBe(true)
    expect(canReplaceTitle('agent', 'model')).toBe(false)
    expect(canReplaceTitle('agent', 'rule')).toBe(false)
    expect(canReplaceTitle('user', 'agent')).toBe(false)
  })
})

describe('titles in the app', () => {
  let db: Db
  let repo: Repo
  let manager: HarnessManager
  let service: ReturnType<typeof createChatService>
  let ingestor: ReturnType<typeof createIngestor>
  let chatId: string
  let friendId: string
  beforeEach(async () => {
    db = await openDb(':memory:')
    repo = createRepo(db)
    ingestor = createIngestor(repo, () => {})
    manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
    manager.register('echo', async () => new EchoAgent())
    service = createChatService({ repo, manager, ingestor, notify: () => {} })
    const ws = await repo.workspaces.create({ name: 'w', path: process.cwd() })
    friendId = (await repo.friends.create({ harness: 'echo', displayName: 'Echo' })).id
    chatId = (await repo.chats.create({ workspaceId: ws.id, friendId })).id
  })
  afterEach(async () => { await manager.disposeAll(); db.close() })

  test('a new chat starts as "New chat"; your first message titles it by rule; later messages do not', async () => {
    expect(await repo.chats.get(chatId)).toMatchObject({ title: 'New chat', titleSource: 'default' })
    await service.send(chatId, 'can you review the auth middleware for race conditions?')
    expect(await repo.chats.get(chatId)).toMatchObject({ title: 'review the auth middleware for race…', titleSource: 'rule' })
    await service.send(chatId, 'something completely different')
    expect((await repo.chats.get(chatId))!.title).toBe('review the auth middleware for race…')
  })

  test('chats created with a title, and chats you rename, are yours: nothing rewrites them', async () => {
    const ws = (await repo.workspaces.list())[0]!
    const named = await repo.chats.create({ workspaceId: ws.id, friendId, title: 'my title' })
    expect(named.titleSource).toBe('user')
    await ingestor.ingest(named.id, { t: 'title', title: 'agent wants this' })
    expect(await repo.chats.setAutoTitle(named.id, 'model wants this', 'model')).toBe(false)
    expect((await repo.chats.get(named.id))!.title).toBe('my title')
    await service.send(chatId, 'first message here')
    await repo.chats.rename(chatId, 'Renamed by me')
    await ingestor.ingest(chatId, { t: 'title', title: 'agent wants this' })
    expect(await repo.chats.get(chatId)).toMatchObject({ title: 'Renamed by me', titleSource: 'user' })
  })

  test("the agent's own title replaces a rule title, and then only an agent title can replace it", async () => {
    await service.send(chatId, 'fix the thing')
    await ingestor.ingest(chatId, { t: 'title', title: '"Fix the flaky session test."' })
    expect(await repo.chats.get(chatId)).toMatchObject({ title: 'Fix the flaky session test', titleSource: 'agent' })
    expect(await repo.chats.setAutoTitle(chatId, 'from a model', 'model')).toBe(false)
    await ingestor.ingest(chatId, { t: 'title', title: 'Updated by the agent' })
    expect((await repo.chats.get(chatId))!.title).toBe('Updated by the agent')
  })

  test('the model titler runs after the first exchange, once, and only over a rule title', async () => {
    const ws0 = (await repo.workspaces.list())[0]!
    chatId = (await repo.chats.create({ workspaceId: ws0.id, friendId: (await repo.friends.create({ harness: 'claude', displayName: 'Claude Code' })).id })).id
    const calls: string[] = []
    const titler = createTitler(repo, async () => ({ baseUrl: 'https://x.test', model: 'm', token: 'k' }), async (_m, user, agent) => { calls.push(`${user} | ${agent}`); return 'Review auth middleware' })
    expect(await titler.maybeRetitle(chatId)).toBe(false) // nothing said yet
    await repo.messages.append({ chatId, role: 'user', kind: 'text', body: {}, text: 'review auth' })
    expect(await titler.maybeRetitle(chatId)).toBe(false) // no agent reply yet
    await repo.messages.append({ chatId, role: 'agent', kind: 'text', body: {}, text: 'Looking at it now.' })
    await repo.chats.setAutoTitle(chatId, 'review auth', 'rule')
    expect(await titler.maybeRetitle(chatId)).toBe(true)
    expect(calls).toEqual(['review auth | Looking at it now.'])
    expect(await repo.chats.get(chatId)).toMatchObject({ title: 'Review auth middleware', titleSource: 'model' })
    expect(await titler.maybeRetitle(chatId)).toBe(false) // already model-titled
    expect(calls).toHaveLength(1)
  })

  test('the titler leaves your title and the agent title alone, skips ASI, and a failing model keeps the rule title', async () => {
    const msgs = async (id: string) => { await repo.messages.append({ chatId: id, role: 'user', kind: 'text', body: {}, text: 'hello' }); await repo.messages.append({ chatId: id, role: 'agent', kind: 'text', body: {}, text: 'hi' }) }
    friendId = (await repo.friends.create({ harness: 'claude', displayName: 'Claude Code' })).id
    chatId = (await repo.chats.create({ workspaceId: (await repo.workspaces.list())[0]!.id, friendId })).id
    let called = 0
    const titler = createTitler(repo, async () => ({ baseUrl: 'https://x.test', model: 'm', token: null }), async () => { called++; return 'Model title' })
    await msgs(chatId)
    await repo.chats.rename(chatId, 'Mine')
    expect(await titler.maybeRetitle(chatId)).toBe(false)
    const ws = (await repo.workspaces.list())[0]!
    const c2 = await repo.chats.create({ workspaceId: ws.id, friendId })
    await msgs(c2.id)
    await repo.chats.setAutoTitle(c2.id, 'From the agent', 'agent')
    expect(await titler.maybeRetitle(c2.id)).toBe(false)
    const asi = await repo.friends.create({ harness: 'asi', displayName: 'ASI2' })
    const c3 = await repo.chats.create({ workspaceId: ws.id, friendId: asi.id })
    await msgs(c3.id)
    expect(await titler.maybeRetitle(c3.id)).toBe(false)
    expect(called).toBe(0)

    const c4 = await repo.chats.create({ workspaceId: ws.id, friendId })
    await msgs(c4.id)
    await repo.chats.setAutoTitle(c4.id, 'hello', 'rule')
    let tries = 0
    const failing = createTitler(repo, async () => ({ baseUrl: 'https://x.test', model: 'm', token: null }), async () => { tries++; throw new Error('rate limited') })
    expect(await failing.maybeRetitle(c4.id)).toBe(false)
    expect(await failing.maybeRetitle(c4.id)).toBe(false)
    expect(await failing.maybeRetitle(c4.id)).toBe(false)
    expect(tries).toBe(2) // gives up after two tries
    expect((await repo.chats.get(c4.id))!.title).toBe('hello')
    const none = createTitler(repo, async () => null)
    expect(await none.maybeRetitle(c4.id)).toBe(false)
  })

  test('llmTitle asks a chat model and cleans its answer; only a general chat model can be the titler', async () => {
    let body: { messages: { content: string }[] } | null = null
    const f = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: 'Title: "Flaky session refresh test"\nHope that helps' } }] })) }) as unknown as typeof fetch
    expect(await llmTitle({ baseUrl: 'http://localhost:11434/v1', model: 'm', fetchImpl: f }, 'fix the flaky test', 'On it.')).toBe('Flaky session refresh test')
    expect(body!.messages[1]!.content).toContain('fix the flaky test')

    const secrets = createSecrets(repo, { available: () => true, encrypt: (s) => s, decrypt: (s) => s })
    const brain = createBrain(repo, secrets, (async (u: string) => new Response(JSON.stringify(String(u).includes('systemone') ? { answers: { ok: { type: 'noul', noul: 0.9 } } } : { choices: [{ message: { content: '{"answers":{"ok":{"noul":0.9}}}' } }] }))) as unknown as typeof fetch)
    expect(await brain.titleModel()).toBeNull()
    await brain.connect({ provider: 'systemone', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', token: 'k' })
    expect(await brain.titleModel()).toBeNull() // Jev classifies; it cannot write a title
    await brain.connect({ provider: 'llm', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' })
    expect(await brain.titleModel()).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' })
  })
})

describe('agents that name their own sessions', () => {
  let s: AgentSession | null = null
  afterEach(async () => { await s?.dispose(); s = null })
  const titles = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'title').map((e) => (e as { title: string }).title)

  test('ACP session_info_update becomes a title event', async () => {
    s = await acpFactory({ command: process.execPath, args: [resolve('test/fixtures/mock-acp-agent.mjs')] })({ friend: friendFor() as never, chatId: 'c', cwd: process.cwd(), mode: 'ask' })
    const c = collect(s); s.send({ text: 'please retitle' }); await c.turnEnd()
    expect(titles(c.events)).toEqual(['Fix the flaky session test'])
  })

  test('Codex thread/name/updated becomes a title event', async () => {
    s = await CodexSession.create({ command: process.execPath, prefixArgs: [resolve('test/fixtures/mock-codex.mjs')], env: process.env, cwd: process.cwd(), mode: 'ask' })
    const c = collect(s); s.send({ text: 'please retitle' }); await c.turnEnd()
    expect(titles(c.events)).toEqual(['Tidy the build script'])
  })
})
