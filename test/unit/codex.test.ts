import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CodexSession } from '../../src/harness/codex/session'
import type { AgentEvent } from '../../src/shared/events'
import type { Mode } from '../../src/shared/models'
import { collect } from './helpers'

const MOCK = resolve('test/fixtures/mock-codex.mjs')
let s: CodexSession | null = null
afterEach(async () => { await s?.dispose(); s = null })

const start = async (mode: Mode = 'ask', resumeId?: string) => {
  s = await CodexSession.create({ command: process.execPath, prefixArgs: [MOCK], env: process.env, cwd: process.cwd(), mode, resumeId })
  return s
}
const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

test('streams message deltas once and completes with usage', async () => {
  const c = collect(await start())
  s!.send({ text: 'hello' })
  await c.turnEnd()
  expect(text(c.events)).toBe('PONG: hello')
  expect(c.events.find((e) => e.t === 'usage')).toMatchObject({ inputTokens: 40, cacheReadTokens: 60, outputTokens: 20 })
  expect(s!.resumeId).toBe('thread-mock-1')
})

test.each([['allow-once', 'accept'], ['allow-chat', 'acceptForSession'], ['deny', 'decline']] as const)('command approval %s -> %s', async (answer, decision) => {
  const c = collect(await start())
  s!.send({ text: 'run a command' })
  const req = (await c.until((e) => e.t === 'permission')) as Extract<AgentEvent, { t: 'permission' }>
  expect(req).toMatchObject({ tool: 'exec', summary: 'rm -rf dist' })
  s!.respond(req.reqId, answer)
  await c.turnEnd()
  expect(text(c.events)).toBe(`decision=${decision}`)
  const tool = c.events.filter((e) => e.t === 'tool').at(-1) as Extract<AgentEvent, { t: 'tool' }>
  expect(tool).toMatchObject({ command: 'rm -rf dist', done: true, output: 'removed' })
})

test('file change approval shows the files with +/- counts', async () => {
  const c = collect(await start())
  s!.send({ text: 'apply a patch' })
  const req = (await c.until((e) => e.t === 'permission')) as Extract<AgentEvent, { t: 'permission' }>
  expect(req).toMatchObject({ tool: 'edit', summary: '/tmp/x.txt' })
  const tool = c.events.find((e) => e.t === 'tool') as Extract<AgentEvent, { t: 'tool' }>
  expect(tool.files).toEqual([{ path: '/tmp/x.txt', added: 2, removed: 0 }])
  s!.respond(req.reqId, 'deny')
  await c.turnEnd()
  expect((c.events.filter((e) => e.t === 'tool').at(-1) as Extract<AgentEvent, { t: 'tool' }>).exit).toBe(1)
})

test('request_user_input becomes a question and the answer is returned by question id', async () => {
  const c = collect(await start())
  s!.send({ text: 'a question' })
  const q = (await c.until((e) => e.t === 'question')) as Extract<AgentEvent, { t: 'question' }>
  expect(q).toMatchObject({ prompt: 'Which lock?', choices: ['Per tab', 'Global'] })
  s!.respond(q.reqId, 'Global')
  await c.turnEnd()
  expect(text(c.events)).toBe('answers={"q":{"answers":["Global"]}}')
})

test('interrupt calls turn/interrupt and ends as interrupted', async () => {
  const c = collect(await start())
  s!.send({ text: 'slow' })
  await c.until((e) => e.t === 'tool')
  const t0 = Date.now()
  await s!.interrupt()
  expect(await c.turnEnd()).toMatchObject({ reason: 'interrupted' })
  expect(Date.now() - t0).toBeLessThan(3000)
})

test('failed turns report the error; resume reuses the thread id', async () => {
  const c = collect(await start('ask', 'thread-old'))
  expect(s!.resumeId).toBe('thread-old')
  s!.send({ text: 'please fail' })
  expect(await c.turnEnd()).toMatchObject({ reason: 'error', error: 'model overloaded' })
})
