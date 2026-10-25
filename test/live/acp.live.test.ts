import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { OPENCODE } from '../../src/harness/acp/presets'
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

describe.skipIf(!live)('opencode (ACP)', async () => {
  const env = await loginEnv()
  const installed = !!which('opencode', env)
  const run = installed ? test : test.skip

  run('answers a simple prompt', async () => {
    session = await acpFactory(OPENCODE)({ friend: friendFor() as never, chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Reply with exactly: PONG' })
    await c.until((e) => e.t === 'turn_end', 120_000)
    expect(text(c.events)).toContain('PONG')
  })

  run('Ask mode: a file write asks first; Deny leaves no file', async () => {
    session = await acpFactory(OPENCODE)({ friend: friendFor() as never, chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Create a file named hello.txt containing the single word hi. Use your file write tool.' })
    const req = (await c.until((e) => e.t === 'permission', 120_000)) as Extract<AgentEvent, { t: 'permission' }>
    expect(req.options.map((o) => o.id)).toContain('deny')
    session.respond(req.reqId, 'deny')
    await c.until((e) => e.t === 'turn_end', 120_000)
    expect(existsSync(join(ws.dir, 'hello.txt'))).toBe(false)
  })

  run('Ask mode: Allow once writes the file', async () => {
    session = await acpFactory(OPENCODE)({ friend: friendFor() as never, chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Create a file named allowed.txt containing the single word yes. Use your file write tool.' })
    const req = (await c.until((e) => e.t === 'permission', 120_000)) as Extract<AgentEvent, { t: 'permission' }>
    session.respond(req.reqId, 'allow-once')
    await c.until((e) => e.t === 'turn_end', 120_000)
    expect(existsSync(join(ws.dir, 'allowed.txt'))).toBe(true)
  })

  run('Nudge interrupts a long turn', async () => {
    session = await acpFactory(OPENCODE)({ friend: friendFor() as never, chatId: 'c', cwd: ws.dir, mode: 'ask' })
    const c = collect(session)
    session.send({ text: 'Write a very long, detailed essay (2000 words) about the history of the telephone.' })
    await c.until((e) => e.t === 'text' || e.t === 'thinking', 120_000)
    await session.interrupt()
    const end = (await c.until((e) => e.t === 'turn_end', 30_000)) as Extract<AgentEvent, { t: 'turn_end' }>
    expect(end.reason).toBe('interrupted')
  })
  run('Auto-edit writes without approval but shell still asks', async () => {
    session = await acpFactory(OPENCODE)({ friend: friendFor() as never, chatId: 'c', cwd: ws.dir, mode: 'auto-edit' })
    const edits = collect(session)
    session.send({ text: 'Create auto-edit.txt containing AUTO using only your file write tool. Do not use shell.' })
    await edits.until(e => e.t === 'turn_end', 120_000)
    expect(edits.events.filter(e => e.t === 'permission')).toHaveLength(0)
    expect(existsSync(join(ws.dir, 'auto-edit.txt'))).toBe(true)
    const shell = collect(session)
    session.send({ text: 'Use your shell tool to run exactly: printf ACP_SHELL_CHECK' })
    const permission = await shell.until(e => e.t === 'permission', 120_000)
    if (permission.t !== 'permission') throw new Error('missing permission')
    session.respond(permission.reqId, 'deny')
    await shell.until(e => e.t === 'turn_end', 120_000)
  })

  run('reset resumes the conversation without duplicating history', async () => {
    const context = { friend: friendFor() as never, chatId: 'c', cwd: ws.dir, mode: 'ask' as const }
    session = await acpFactory(OPENCODE)(context)
    const first = collect(session)
    session.send({ text: 'Remember this secret token: ACP_RESET_CEDAR. Reply OK without using tools.' })
    await first.until(e => e.t === 'turn_end', 120_000)
    const resumeId = session.resumeId
    await session.dispose()
    session = await acpFactory(OPENCODE)({ ...context, resumeId })
    const resumed = collect(session)
    session.send({ text: 'What was the secret token I asked you to remember? Reply with only the token.' })
    await resumed.until(e => e.t === 'turn_end', 120_000)
    expect(session.resumeId).toBe(resumeId)
    expect(text(resumed.events)).toContain('ACP_RESET_CEDAR')
  })

})
