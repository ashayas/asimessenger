import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor, type Ingestor } from '../../src/main/ingest'

let db: Db
let repo: Repo
let ing: Ingestor
let chatId: string
beforeEach(async () => {
  db = await openDb(':memory:')
  repo = createRepo(db)
  const ws = await repo.workspaces.create({ name: 'scratch', path: '/tmp' })
  const f = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
  chatId = (await repo.chats.create({ workspaceId: ws.id, friendId: f.id })).id
  ing = createIngestor(repo, () => {})
})
afterEach(() => { vi.useRealTimers(); db.close() })

const delta = (text: string) => ing.ingest(chatId, { t: 'text', id: 'reply', delta: text })
const end = () => ing.ingest(chatId, { t: 'turn_end', reason: 'done' })
const reply = async () => (await repo.messages.list(chatId)).find((m) => m.role === 'agent' && m.kind === 'text')?.text

test('keeps the entire reply across multiple timed flushes and tool boundaries', async () => {
  vi.useFakeTimers()
  const update = vi.spyOn(repo.messages, 'update')
  await delta('First')
  await delta(' chunk')
  await vi.advanceTimersByTimeAsync(80); await ing.idle(chatId)
  expect(await reply()).toBe('First chunk')
  await delta(' second')
  await vi.advanceTimersByTimeAsync(80); await ing.idle(chatId)
  expect(await reply()).toBe('First chunk second')
  const writes = update.mock.calls.length
  await ing.ingest(chatId, { t: 'tool', id: 'read', kind: 'read', title: 'Read', done: true })
  expect(update).toHaveBeenCalledTimes(writes) // no rewriting unchanged text on every tool event
  await delta(' final')
  await end()
  expect(await reply()).toBe('First chunk second final')
})

test('a slow timer flush cannot clear or overwrite chunks arriving during the write', async () => {
  vi.useFakeTimers()
  const original = repo.messages.update
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  vi.spyOn(repo.messages, 'update').mockImplementationOnce(async (...args) => { await gate; return original(...args) })
  await delta('a'); await delta('b')
  await vi.advanceTimersByTimeAsync(80)
  const incoming = delta('c')
  const finished = end()
  release()
  await Promise.all([incoming, finished])
  expect(await reply()).toBe('abc')
})

test('a 10,000-chunk burst preserves order with one batched text update', async () => {
  vi.useFakeTimers()
  const writes = vi.spyOn(repo.messages, 'update')
  const chunks = Array.from({ length: 10_000 }, (_, i) => `${i},`)
  const started = performance.now()
  await Promise.all(chunks.map(delta))
  await end()
  expect(await reply()).toBe(chunks.join(''))
  expect(writes).toHaveBeenCalledTimes(1)
  console.info(`Streaming burst: ${chunks.length} chunks, ${chunks.join('').length} characters, ${(performance.now() - started).toFixed(1)}ms, ${writes.mock.calls.length} text update`)
})
