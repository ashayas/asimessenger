import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import type { AgentSession } from '../../src/shared/events'
import { collect, friendFor } from './helpers'

const MOCK = resolve('test/fixtures/mock-acp-agent.mjs')
const factory = acpFactory({ command: process.execPath, args: [MOCK] })
let session: AgentSession | null = null
afterEach(async () => { await session?.dispose(); session = null })

const start = async (over: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => {
  session = await factory({ friend: friendFor(over) as never, chatId: 'c', cwd: process.cwd(), mode: 'ask', ...ctx })
  return session
}

test('streams text chunks and ends the turn', async () => {
  const s = await start()
  const c = collect(s)
  s.send({ text: 'hello' })
  await c.turnEnd()
  const text = c.events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
  expect(text).toBe('PONG: hello')
  expect(c.events.at(-1)).toMatchObject({ t: 'turn_end', reason: 'done' })
  expect(s.resumeId).toBe('mock-session-1')
})

test('tool_call + updates merge into one block with command, output and exit code', async () => {
  const s = await start()
  const c = collect(s)
  s.send({ text: 'run a tool' })
  await c.turnEnd()
  const tools = c.events.filter((e) => e.t === 'tool') as Extract<(typeof c.events)[number], { t: 'tool' }>[]
  const last = tools.at(-1)!
  expect(last).toMatchObject({ id: 't1', kind: 'exec', command: 'echo hi', output: 'hi', exit: 0, done: true })
  expect(c.events.some((e) => e.t === 'thinking')).toBe(true)
})

test('permission requests map options and the answer reaches the agent', async () => {
  for (const [ours, theirs] of [['allow-once', 'allow'], ['allow-chat', 'always'], ['deny', 'reject']] as const) {
    const s = await start()
    const c = collect(s)
    s.send({ text: 'permission please' })
    const req = (await c.until((e) => e.t === 'permission')) as Extract<(typeof c.events)[number], { t: 'permission' }>
    expect(req.summary).toBe('rm -rf dist')
    expect(req.options.map((o) => o.id)).toEqual(['allow-once', 'allow-chat', 'deny'])
    s.respond(req.reqId, ours)
    await c.turnEnd()
    expect(c.events.find((e) => e.t === 'text')).toMatchObject({ delta: `permission answer: ${theirs}` })
    await s.dispose()
  }
})

test('plans surface as a plan attachment', async () => {
  const s = await start()
  const c = collect(s)
  s.send({ text: 'make a plan' })
  await c.turnEnd()
  expect(c.events.find((e) => e.t === 'attachment')).toMatchObject({ kind: 'plan', body: '- [x] step one\n- [ ] step two' })
})

test('interrupt cancels a running turn', async () => {
  const s = await start()
  const c = collect(s)
  s.send({ text: 'slow job' })
  await c.until((e) => e.t === 'tool')
  const t0 = Date.now()
  await s.interrupt()
  const end = await c.turnEnd()
  expect(end).toMatchObject({ reason: 'interrupted' })
  expect(Date.now() - t0).toBeLessThan(3000)
})

test('resume uses session/load and does not replay history into the chat', async () => {
  const s = await start({}, { resumeId: 'mock-session-1' })
  const c = collect(s)
  s.send({ text: 'after resume' })
  await c.turnEnd()
  expect(c.events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('PONG: after resume')
})

test('quotes are prepended to the prompt', async () => {
  const s = await start()
  const c = collect(s)
  s.send({ text: 'thoughts?', quote: { name: 'notes.md', text: 'line one' } })
  await c.turnEnd()
  const text = c.events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
  expect(text).toContain('> line one')
  expect(text).toContain('thoughts?')
})

test('missing command and dangerous gate are reported clearly', async () => {
  await expect(factory({ friend: friendFor({ command: 'definitely-not-a-real-cli' }) as never, chatId: 'c', cwd: '/tmp', mode: 'ask' })).rejects.toThrow(/not found on your PATH/)
  await expect(factory({ friend: friendFor({ dangerousAllowed: false }) as never, chatId: 'c', cwd: '/tmp', mode: 'dangerous' })).rejects.toThrow(/dangerous mode/)
})
