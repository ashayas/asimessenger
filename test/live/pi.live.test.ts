import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { loginEnv, which } from '../../src/harness/env'
import { configurePi, piFactory } from '../../src/harness/pi/factory'
import { createMcpBridge } from '../../src/main/mcp-bridge'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import type { Mode } from '../../src/shared/models'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

// needs a Pi login (`pi` then /login) or a provider key; set ASI_PI_ARGS to pick a model
const live = !!process.env['ASI_LIVE']
const MODEL_ARGS = (process.env['ASI_PI_ARGS'] ?? '--provider openrouter --model anthropic/claude-haiku-4.5').split(' ')
let ws: ReturnType<typeof makeTestWorkspace>
let session: AgentSession | null = null
const asked: string[] = []
const bridge = createMcpBridge({
  chatExists: async () => true,
  askUser: async (_id, q) => { asked.push(q); return 'Tangerine' },
  sendAttachment: async () => {}, openUrl: async () => {}, openDrawing: async () => {}, setStatus: async () => {}
})
beforeAll(async () => { ws = makeTestWorkspace(); await bridge.start(); configurePi({ extensionPath: resolve('native/pi/asi-extension.js') }) })
afterAll(async () => { ws?.cleanup(); await bridge.stop() })
afterEach(async () => { await session?.dispose(); session = null; asked.length = 0 })

const text = (events: AgentEvent[]) => events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
const T = 120_000

async function start(mode: Mode, over: Record<string, unknown> = {}) {
  session = await piFactory({ friend: friendFor({ harness: 'pi', args: MODEL_ARGS, ...over }) as never, chatId: 'live-chat', cwd: ws.dir, mode, mcp: bridge.endpointFor('live-chat') })
  return collect(session)
}

describe.skipIf(!live)('pi (native RPC)', async () => {
  const env = await loginEnv()
  const run = which('pi', env) ? test : test.skip

  run('answers a simple prompt', async () => {
    const c = await start('ask')
    session!.send({ text: 'Reply with exactly: PONG' })
    await c.until((e) => e.t === 'turn_end', T)
    expect(text(c.events)).toContain('PONG')
    expect(c.events.find((e) => e.t === 'turn_end')).toMatchObject({ reason: 'done' })
    expect(c.events.some((e) => e.t === 'usage')).toBe(true)
  })

  run('Ask mode: a file write asks first; Deny leaves no file', async () => {
    const c = await start('ask')
    session!.send({ text: 'Create a file named hello.txt containing the single word hi. Use your write tool.' })
    const req = (await c.until((e) => e.t === 'permission', T)) as Extract<AgentEvent, { t: 'permission' }>
    expect(req.tool).toBe('write')
    expect(req.options.map((o) => o.id)).toEqual(['allow-once', 'allow-chat', 'deny'])
    session!.respond(req.reqId, 'deny')
    await c.until((e) => e.t === 'turn_end', T)
    expect(existsSync(join(ws.dir, 'hello.txt'))).toBe(false)
  })

  run('Ask mode: Allow once writes the file', async () => {
    const c = await start('ask')
    session!.send({ text: 'Create a file named allowed.txt containing the single word yes. Use your write tool.' })
    const req = (await c.until((e) => e.t === 'permission', T)) as Extract<AgentEvent, { t: 'permission' }>
    session!.respond(req.reqId, 'allow-once')
    await c.until((e) => e.t === 'turn_end', T)
    expect(readFileSync(join(ws.dir, 'allowed.txt'), 'utf8')).toContain('yes')
  })

  run('Plan mode: writes are blocked without prompting', async () => {
    const c = await start('plan')
    session!.send({ text: 'Create a file named plan.txt containing the word no. Use your write tool, then say what happened.' })
    await c.until((e) => e.t === 'turn_end', T)
    expect(c.events.some((e) => e.t === 'permission')).toBe(false)
    expect(existsSync(join(ws.dir, 'plan.txt'))).toBe(false)
  })

  run('Auto-edit: writes go through, bash still asks', async () => {
    const c = await start('auto-edit')
    session!.send({ text: 'Use your write tool to create auto.txt containing ok, then use bash to run: echo done' })
    const req = (await c.until((e) => e.t === 'permission', T)) as Extract<AgentEvent, { t: 'permission' }>
    expect(req.tool).toBe('bash')
    session!.respond(req.reqId, 'deny')
    await c.until((e) => e.t === 'turn_end', T)
    expect(existsSync(join(ws.dir, 'auto.txt'))).toBe(true)
  })

  run('switching mode mid-session takes effect', async () => {
    const c = await start('ask', { dangerousAllowed: true })
    session!.setMode('dangerous')
    session!.send({ text: 'Create a file named free.txt containing the word go. Use your write tool.' })
    await c.until((e) => e.t === 'turn_end', T)
    expect(c.events.some((e) => e.t === 'permission')).toBe(false)
    expect(existsSync(join(ws.dir, 'free.txt'))).toBe(true)
  })

  run('refuses dangerous when the friend has not opted in', async () => {
    await expect(start('dangerous')).rejects.toThrow(/not enabled/)
  })

  run('calls ask_user through the ASI bridge', async () => {
    const c = await start('ask')
    session!.send({ text: "Use the ask_user tool to ask the human: 'What is the secret fruit?'. Then reply with exactly the answer the human gave, nothing else." })
    await c.until((e) => e.t === 'turn_end', T)
    expect(asked[0]).toContain('secret fruit')
    expect(text(c.events)).toContain('Tangerine')
  })

  run('Nudge interrupts a running turn', async () => {
    const c = await start('dangerous', { dangerousAllowed: true })
    session!.send({ text: 'Run `sleep 60` with your bash tool, then say done.' })
    await c.until((e) => e.t === 'tool', T)
    await session!.interrupt()
    expect(c.events.find((e) => e.t === 'turn_end')).toMatchObject({ reason: 'interrupted' })
  })

  run('resumes a session by file and remembers it', async () => {
    const a = await start('ask')
    session!.send({ text: 'Remember the codeword MANGO. Reply with just OK.' })
    await a.until((e) => e.t === 'turn_end', T)
    const id = session!.resumeId!
    expect(existsSync(id)).toBe(true)
    await session!.dispose()
    session = await piFactory({ friend: friendFor({ harness: 'pi', args: MODEL_ARGS }) as never, chatId: 'live-chat', cwd: ws.dir, mode: 'ask', resumeId: id })
    const b = collect(session)
    session.send({ text: 'What was the codeword? Reply with just the word.' })
    await b.until((e) => e.t === 'turn_end', T)
    expect(text(b.events).toUpperCase()).toContain('MANGO')
  })
})
