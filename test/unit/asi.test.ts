import { afterEach, beforeEach, expect, test } from 'vitest'
import { AsiAgent } from '../../src/asi/agent'
import { createBrain } from '../../src/asi/brain'
import type { Decider } from '../../src/asi/decider'
import { adoptSession } from '../../src/main/adopt'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createSecrets, type SecretCrypto } from '../../src/main/secrets'
import { searchAll } from '../../src/main/search'
import type { AgentEvent } from '../../src/shared/events'
import { collect } from './helpers'

let db: Db
let repo: Repo
beforeEach(async () => { db = await openDb(':memory:'); repo = createRepo(db) })
afterEach(() => db.close())

const ask = async (a: AsiAgent, text: string) => {
  const c = collect(a)
  a.send({ text })
  await c.turnEnd()
  const links = (c.events.find((e) => e.t === 'links') as Extract<AgentEvent, { t: 'links' }> | undefined)?.items ?? []
  return { text: c.events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join(''), links }
}
const agent = (over: Partial<ConstructorParameters<typeof AsiAgent>[0]> = {}) =>
  new AsiAgent({ repo, decider: async () => null, discover: async () => [], search: (q) => searchAll(repo, q), ...over })

async function world() {
  const ws = await repo.workspaces.create({ name: 'honeycomb', path: '/code/hc' })
  const claude = await repo.friends.create({ harness: 'claude', displayName: 'Claude Code' })
  const codex = await repo.friends.create({ harness: 'codex', displayName: 'Codex' })
  const c1 = await repo.chats.create({ workspaceId: ws.id, friendId: claude.id, title: 'auth refactor' })
  await repo.chats.setStatus(c1.id, 'busy', '✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧')
  const c2 = await repo.chats.create({ workspaceId: ws.id, friendId: codex.id, title: 'build fix' })
  await repo.chats.setStatus(c2.id, 'away', '(⊙_⊙) waiting on u: rm -rf dist')
  return { ws, claude, codex, c1, c2 }
}

test('help, status and who-needs-me read your live data and link to the chats', async () => {
  expect((await ask(agent(), 'help')).text).toContain('who needs me')
  expect((await ask(agent(), 'status')).text).toContain('All quiet')
  const w = await world()
  const status = await ask(agent(), 'what is everyone working on right now?')
  expect(status.text).toContain('Codex is waiting on you in “build fix”')
  expect(status.text).toContain('Claude Code is working in “auth refactor”')
  expect(status.links.map((l) => l.target)).toEqual([expect.objectContaining({ type: 'chat', chatId: w.c2.id }), expect.objectContaining({ type: 'chat', chatId: w.c1.id })])
  const waiting = await ask(agent(), 'who needs me?')
  expect(waiting.text).toContain('1 chat needs you')
  expect(waiting.links[0]!.detail).toContain('Codex')
})

test('outside lists discovered sessions that Messenger does not already own, and adoption wires them to a chat', async () => {
  const w = await world()
  await repo.chats.setSession(w.c1.id, 'owned-1')
  const found = [
    { harness: 'claude' as const, sessionId: 'owned-1', cwd: '/code/hc', title: 'already here', lastActive: Date.now() },
    { harness: 'claude' as const, sessionId: 'ext-2', cwd: '/code/hc/packages/api', title: 'add pagination', lastActive: Date.now() - 120_000 }
  ]
  const r = await ask(agent({ discover: async () => found }), 'what is running outside?')
  expect(r.links).toHaveLength(1)
  expect(r.links[0]).toMatchObject({ label: 'add pagination', target: { type: 'adopt', sessionId: 'ext-2' } })
  expect((await ask(agent(), 'outside')).text).toContain('don’t see any')

  const chatId = await adoptSession(repo, r.links[0]!.target as never)
  const chat = (await repo.chats.get(chatId))!
  expect(chat).toMatchObject({ workspaceId: w.ws.id, friendId: w.claude.id, harnessSessionId: 'ext-2', title: 'add pagination' })
  expect(await adoptSession(repo, r.links[0]!.target as never)).toBe(chatId) // idempotent
  const fresh = await adoptSession(repo, { type: 'adopt', harness: 'claude', sessionId: 'ext-9', cwd: '/elsewhere/proj', title: 't' })
  expect((await repo.workspaces.get((await repo.chats.get(fresh))!.workspaceId))!).toMatchObject({ name: 'proj', path: '/elsewhere/proj' })
  await repo.friends.remove(w.codex.id)
  await expect(adoptSession(repo, { type: 'adopt', harness: 'codex', sessionId: 'x', cwd: '/c', title: 't' })).rejects.toThrow(/add Codex as a friend first/)
})

test('find never matches ASI\'s own conversation with you', async () => {
  const w = await world()
  const asiFriend = await repo.friends.create({ harness: 'asi', displayName: 'ASI' })
  const mine = await repo.chats.create({ workspaceId: w.ws.id, friendId: asiFriend.id, title: 'asi chat' })
  await repo.messages.append({ chatId: mine.id, role: 'user', kind: 'text', body: {}, text: 'find the zebra deployment' })
  await repo.messages.append({ chatId: w.c1.id, role: 'agent', kind: 'text', body: {}, text: 'zebra deployment notes' })
  const r = await ask(agent(), 'find the zebra deployment')
  expect(r.text).toContain('Best match: “auth refactor”')
  expect(r.links).toHaveLength(1)
})

test('find searches everything; a connected decider picks the best chat', async () => {
  const w = await world()
  await repo.messages.append({ chatId: w.c1.id, role: 'agent', kind: 'text', body: {}, text: 'the refresh lock should be global' })
  await repo.messages.append({ chatId: w.c2.id, role: 'agent', kind: 'text', body: {}, text: 'refresh the build cache' })
  const one = await ask(agent(), 'find the refresh lock') // only one chat has both words
  expect(one.text).toContain('Best match: “auth refactor”')
  const plain = await ask(agent(), 'find refresh')
  expect(plain.text).toContain('matches') // ambiguous and no decider: just list them
  expect(plain.links.length).toBeGreaterThan(1)
  const decider: Decider = { id: 'clef-flash', decide: async (_s, q) => ({ match: { choice: Object.keys((q['match'] as { criteria: Record<string, string> }).criteria).find((k) => (q['match'] as { criteria: Record<string, string> }).criteria[k]!.includes('global'))!, probabilities: { x: 0.9 } } }) }
  const smart = await ask(agent({ decider: async () => decider }), 'which chat was about the lock thing?')
  expect(smart.text).toContain('Best match: “auth refactor”')
  expect((await ask(agent(), 'find zzzzqqqq')).text).toContain('couldn’t find')
})

const crypto: SecretCrypto = { available: () => true, encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (c) => Buffer.from(c.slice(4), 'base64').toString() }
const ID = 'a'.repeat(32)

test('connecting the brain validates with one real decision, stores the token encrypted, and never on failure', async () => {
  const secrets = createSecrets(repo, crypto)
  let calls = 0
  const ok = (async () => { calls++; return new Response(JSON.stringify({ result: { answers: { ok: { noul: 0.9 } } } })) }) as unknown as typeof fetch
  const brain = createBrain(repo, secrets, ok)
  expect(await brain.status()).toEqual({ connected: false })
  await expect(brain.connect({ accountId: 'nope', token: 'x'.repeat(30), model: 'clef-flash' })).rejects.toThrow(/32 hex/)
  await expect(brain.connect({ accountId: ID, token: 'short', model: 'clef-flash' })).rejects.toThrow(/API token/)
  expect(calls).toBe(0)
  const r = await brain.connect({ accountId: ID, token: 't'.repeat(40), model: 'clef' })
  expect(calls).toBe(1)
  expect(r.costPerDecisionUsd).toBeCloseTo(0.000036, 6)
  expect(await brain.status()).toEqual({ connected: true, model: 'clef', accountId: 'aaaa…aaaa' })
  expect(JSON.stringify(await repo.settings.get('secret:cloudflare-token', null))).not.toContain('tttt') // encrypted at rest
  expect((await brain.decider())!.id).toBe('clef')
  await brain.disconnect()
  expect(await brain.status()).toEqual({ connected: false })
  expect(await brain.decider()).toBeNull()

  const bad = createBrain(repo, secrets, (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }), { status: 403 })) as unknown as typeof fetch)
  await expect(bad.connect({ accountId: ID, token: 't'.repeat(40), model: 'clef-flash' })).rejects.toThrow(/Invalid API Token/)
  expect(await bad.status()).toEqual({ connected: false })
})

test('without a usable keychain nothing is stored', async () => {
  const secrets = createSecrets(repo, { ...crypto, available: () => false })
  await expect(secrets.set('x', 'y')).rejects.toThrow(/keychain/)
})
