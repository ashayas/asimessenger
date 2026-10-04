import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PiSession } from '../../src/harness/pi/session'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import type { Mode } from '../../src/shared/models'
import { collect } from './helpers'

const MOCK = join(__dirname, '../fixtures/mock-pi.mjs')
let session: AgentSession | null = null
afterEach(async () => { await session?.dispose(); session = null })

const make = (mode: Mode = 'ask', over: Partial<ConstructorParameters<typeof PiSession>[0]> = {}) => {
  const s = new PiSession({ command: process.execPath, prefixArgs: [MOCK], env: process.env, cwd: process.cwd(), mode, dangerousAllowed: true, sessionFile: '/tmp/x.jsonl', extensionPath: '/tmp/ext.js', ...over })
  session = s
  return { s, c: collect(s) }
}
const text = (events: AgentEvent[]) => events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

describe('PiSession (mock pi --mode rpc)', () => {
  test('streams thinking and text, reports usage, ends the turn', async () => {
    const { s, c } = make()
    s.send({ text: 'hello' })
    await c.turnEnd()
    expect(text(c.events)).toBe('echo: hello')
    expect(c.events.some((e) => e.t === 'thinking')).toBe(true)
    expect(c.events.find((e) => e.t === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 })
    expect(c.events.find((e) => e.t === 'turn_end')).toMatchObject({ reason: 'done' })
  })

  test('the session file is the resume id', () => {
    expect(make().s.resumeId).toBe('/tmp/x.jsonl')
  })

  test('a quoted attachment reply is folded into the prompt', async () => {
    const { s, c } = make()
    s.send({ text: 'why?', quote: { name: 'plan.md', text: 'step 1' } })
    await c.turnEnd()
    expect(text(c.events)).toContain('> step 1')
  })

  test('the gate extension asks; Allow once runs the tool', async () => {
    const { s, c } = make('ask')
    s.send({ text: 'BASH' })
    const req = (await c.until((e) => e.t === 'permission')) as Extract<AgentEvent, { t: 'permission' }>
    expect(req).toMatchObject({ tool: 'bash', summary: 'echo hi' })
    expect(req.options.map((o) => o.id)).toEqual(['allow-once', 'deny'])
    s.respond(req.reqId, 'allow-once')
    await c.turnEnd()
    const done = c.events.filter((e) => e.t === 'tool' && e.done).pop() as Extract<AgentEvent, { t: 'tool' }>
    expect(done).toMatchObject({ kind: 'exec', command: 'echo hi', output: 'ran', exit: 0 })
  })

  test('Deny reaches the tool as an error', async () => {
    const { s, c } = make('ask')
    s.send({ text: 'BASH' })
    const req = (await c.until((e) => e.t === 'permission')) as Extract<AgentEvent, { t: 'permission' }>
    s.respond(req.reqId, 'deny')
    await c.turnEnd()
    expect(c.events.filter((e) => e.t === 'tool' && e.done).pop()).toMatchObject({ output: 'blocked', exit: 1 })
  })

  test('the mode file follows setMode, and dangerous needs the per-friend opt-in', async () => {
    const { s, c } = make('ask')
    s.setMode('dangerous')
    s.send({ text: 'BASH' })
    await c.turnEnd()
    expect(c.events.some((e) => e.t === 'permission')).toBe(false)
    const locked = make('ask', { dangerousAllowed: false })
    locked.s.setMode('dangerous')
    locked.s.send({ text: 'BASH' })
    await locked.c.until((e) => e.t === 'permission')
  })

  test('the mode file starts at the chat mode', () => {
    const { s } = make('plan')
    expect(readFileSync((s as unknown as { modeFile: string }).modeFile, 'utf8')).toBe('plan')
  })

  test('Nudge aborts a running turn', async () => {
    const { s, c } = make()
    s.send({ text: 'SLOW' })
    await c.until((e) => e.t === 'text')
    await s.interrupt()
    expect(c.events.find((e) => e.t === 'turn_end')).toMatchObject({ reason: 'interrupted' })
  })

  test('Nudge while waiting on a permission cancels the dialog', async () => {
    const { s, c } = make('ask')
    s.send({ text: 'BASH' })
    await c.until((e) => e.t === 'permission')
    await s.interrupt()
    expect(c.events.find((e) => e.t === 'turn_end')).toMatchObject({ reason: 'interrupted' })
  })

  test('a model error becomes an error turn', async () => {
    const { s, c } = make()
    s.send({ text: 'FAIL' })
    expect(await c.turnEnd()).toMatchObject({ reason: 'error', error: 'rate limited' })
  })

  test('a rejected prompt becomes an error turn', async () => {
    const { s, c } = make()
    s.send({ text: 'REJECT' })
    expect(await c.turnEnd()).toMatchObject({ reason: 'error', error: 'no model configured' })
  })

  test('a missing binary fails the turn instead of crashing', async () => {
    const { s, c } = make('ask', { command: '/nonexistent/pi', prefixArgs: [] })
    s.send({ text: 'hi' })
    expect(await c.turnEnd()).toMatchObject({ reason: 'error' })
  })
})
