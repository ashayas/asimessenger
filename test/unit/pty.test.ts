import { afterEach, expect, test } from 'vitest'
import { PtySession } from '../../src/harness/pty/session'
import { stripAnsi } from '../../src/harness/pty/ansi'
import type { AgentEvent } from '../../src/shared/events'
import { collect } from './helpers'

let s: PtySession | null = null
afterEach(async () => { await s?.dispose(); s = null })
const start = (over: Partial<ConstructorParameters<typeof PtySession>[0]> = {}) =>
  (s = new PtySession({ command: '/bin/sh', args: [], cwd: '/tmp', env: { PATH: '/usr/bin:/bin', PS1: '$ ', HOME: '/tmp' }, idleMs: 300, ...over }))
const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

test('stripAnsi removes colors, cursor moves, titles and resolves carriage returns', () => {
  expect(stripAnsi('\u001b[31mred\u001b[0m plain')).toBe('red plain')
  expect(stripAnsi('\u001b]0;title\u0007hello')).toBe('hello')
  expect(stripAnsi('progress 10%\rprogress 100%\n')).toBe('progress 100%\n')
  expect(stripAnsi('a\u001b[2K\u001b[1Gb')).toBe('ab')
})

test('typing a command runs it and the output arrives as plain text; the turn ends when quiet', async () => {
  const c = collect(start())
  s!.send({ text: 'echo hello-from-pty' })
  const end = await c.turnEnd()
  expect(end).toMatchObject({ reason: 'done' })
  expect(text(c.events)).toContain('hello-from-pty')
  expect(c.events.some((e) => e.t === 'status' && e.phase === 'tool')).toBe(true)
})

test('raw listeners and the scrollback see the same bytes', async () => {
  start()
  let seen = ''
  s!.onRaw((d) => { seen += d })
  s!.write('echo raw-bytes\r')
  await new Promise((r) => setTimeout(r, 500))
  expect(seen).toContain('raw-bytes')
  expect(s!.buffer).toContain('raw-bytes')
})

test('interrupt sends Ctrl-C: a long sleep stops and the shell is usable again', async () => {
  const c = collect(start({ idleMs: 4000 }))
  s!.send({ text: 'sleep 30' })
  await new Promise((r) => setTimeout(r, 300))
  const t0 = Date.now()
  await s!.interrupt()
  expect(await c.turnEnd()).toMatchObject({ reason: 'interrupted' })
  expect(Date.now() - t0).toBeLessThan(2000)
  const c2 = collect(s!)
  s!.send({ text: 'echo still-alive' })
  await c2.turnEnd()
  expect(text(c2.events)).toContain('still-alive')
})

test('a process that exits ends the turn with an error', async () => {
  const c = collect(start())
  s!.send({ text: 'exit 3' })
  const end = (await c.until((e) => e.t === 'turn_end' && e.reason === 'error')) as Extract<AgentEvent, { t: 'turn_end' }>
  expect(end.error).toContain('code 3')
  expect(s!.isExited).toBe(true)
})

test('resize is accepted', () => {
  start()
  s!.resize(120, 40)
})
