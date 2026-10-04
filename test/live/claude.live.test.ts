import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { claudeFactory } from '../../src/harness/claude/factory'
import { loginEnv, which } from '../../src/harness/env'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
let session: AgentSession | null = null
beforeAll(() => { ws = makeTestWorkspace() })
afterAll(() => ws?.cleanup())
afterEach(async () => { await session?.dispose(); session = null })

const text = (events: AgentEvent[]) => events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
const friend = (over: Record<string, unknown> = {}) => friendFor({ harness: 'claude', args: ['--model', 'haiku'], ...over }) as never
const T = 150_000

describe.skipIf(!live)('claude (stream-json)', async () => {
  const installed = !!which('claude', await loginEnv())
  const run = installed ? test : test.skip

  run('answers a simple prompt', async () => {
    session = await claudeFactory({ friend: friend(), chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Reply with exactly: PONG' })
    await c.until((e) => e.t === 'turn_end', T)
    expect(text(c.events)).toContain('PONG')
    expect(c.events.at(-1)).toMatchObject({ t: 'turn_end', reason: 'done' })
  })

  run('Ask mode: Deny leaves no file', async () => {
    session = await claudeFactory({ friend: friend(), chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Create a file named hello.txt containing the word hi using the Write tool.' })
    const req = (await c.until((e) => e.t === 'permission', T)) as Extract<AgentEvent, { t: 'permission' }>
    expect(req.tool).toBe('Write')
    session.respond(req.reqId, 'deny', 'not now')
    await c.until((e) => e.t === 'turn_end', T)
    expect(existsSync(join(ws.dir, 'hello.txt'))).toBe(false)
  })

  run('Ask mode: Allow once writes the file', async () => {
    session = await claudeFactory({ friend: friend(), chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Create a file named allowed.txt containing the word yes using the Write tool.' })
    const req = (await c.until((e) => e.t === 'permission', T)) as Extract<AgentEvent, { t: 'permission' }>
    session.respond(req.reqId, 'allow-once')
    await c.until((e) => e.t === 'turn_end', T)
    expect(existsSync(join(ws.dir, 'allowed.txt'))).toBe(true)
  })

  run('Nudge interrupts a long turn', async () => {
    session = await claudeFactory({ friend: friend(), chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Write a very long, detailed essay (2000 words) about the history of the telephone.' })
    await c.until((e) => e.t === 'text', T)
    await session.interrupt()
    expect(await c.until((e) => e.t === 'turn_end', 30_000)).toMatchObject({ reason: 'interrupted' })
  })

  run('resume remembers the conversation', async () => {
    session = await claudeFactory({ friend: friend(), chatId: 'c', cwd: ws.dir, mode: 'ask' })
    let c = collect(session)
    session.send({ text: 'Remember the secret word "tangerine". Reply with just OK.' })
    await c.until((e) => e.t === 'turn_end', T)
    const id = session.resumeId!
    await session.dispose()

    session = await claudeFactory({ friend: friend(), chatId: 'c', cwd: ws.dir, mode: 'ask', resumeId: id })
    c = collect(session)
    session.send({ text: 'What was the secret word? Reply with just the word.' })
    await c.until((e) => e.t === 'turn_end', T)
    expect(text(c.events).toLowerCase()).toContain('tangerine')
  })
})
