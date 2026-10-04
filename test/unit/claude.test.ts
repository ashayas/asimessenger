import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ClaudeSession } from '../../src/harness/claude/session'
import type { AgentEvent } from '../../src/shared/events'
import { collect } from './helpers'

const MOCK = resolve('test/fixtures/mock-claude.mjs')
let s: ClaudeSession | null = null
afterEach(async () => { await s?.dispose(); s = null })

const start = (over: Record<string, unknown> = {}) => {
  // run the mock through node; ClaudeSession spawns `command args...`, so wrap with a tiny shim via extraArgs trick
  s = new ClaudeSession({ command: process.execPath, env: process.env, cwd: process.cwd(), mode: 'ask', dangerousAllowed: false, extraArgs: [], ...over, prefixArgs: [MOCK] } as never)
  return s
}
const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

test('streams text deltas once (assistant echo is not duplicated) and finishes', async () => {
  const c = collect(start())
  s!.send({ text: 'hello' })
  await c.turnEnd()
  expect(text(c.events)).toBe('PONG: hello')
  expect(c.events.at(-1)).toMatchObject({ t: 'turn_end', reason: 'done' })
  expect(c.events.find((e) => e.t === 'usage')).toMatchObject({ outputTokens: 2, costUsd: 0.001 })
})

test.each([['allow-once', 'behavior=allow'], ['allow-chat', 'behavior=allow+perms'], ['deny', 'behavior=deny']] as const)('permission %s reaches claude', async (answer, expected) => {
  const c = collect(start())
  s!.send({ text: 'perm' })
  const req = (await c.until((e) => e.t === 'permission')) as Extract<AgentEvent, { t: 'permission' }>
  expect(req).toMatchObject({ tool: 'Bash', summary: 'rm -rf dist' })
  expect(req.options.map((o) => o.id)).toEqual(['allow-once', 'allow-chat', 'deny'])
  s!.respond(req.reqId, answer, 'because')
  await c.turnEnd()
  expect(text(c.events)).toBe(expected)
  const tool = c.events.filter((e) => e.t === 'tool').at(-1) as Extract<AgentEvent, { t: 'tool' }>
  expect(tool).toMatchObject({ id: 'tu1', kind: 'exec', command: 'rm -rf dist', done: true, exit: answer === 'deny' ? 1 : 0 })
})

test('AskUserQuestion becomes a question card and the answer is returned', async () => {
  const c = collect(start())
  s!.send({ text: 'ask me' })
  const q = (await c.until((e) => e.t === 'question')) as Extract<AgentEvent, { t: 'question' }>
  expect(q).toMatchObject({ prompt: 'Which lock?', choices: ['Per tab', 'Global'] })
  s!.respond(q.reqId, 'Global')
  await c.turnEnd()
  expect(text(c.events)).toBe('answers={"Which lock?":"Global"}')
})

test('interrupt ends the turn as interrupted, quickly', async () => {
  const c = collect(start())
  s!.send({ text: 'slow' })
  await c.until((e) => e.t === 'text')
  const t0 = Date.now()
  await s!.interrupt()
  expect(await c.turnEnd()).toMatchObject({ reason: 'interrupted' })
  expect(Date.now() - t0).toBeLessThan(3000)
})

test('new sessions get a session id; resume reuses the given one', async () => {
  const a = start()
  expect(a.resumeId).toMatch(/^[0-9a-f-]{36}$/)
  await a.dispose()
  const b = start({ resumeId: 'abc-123' })
  expect(b.resumeId).toBe('abc-123')
})
