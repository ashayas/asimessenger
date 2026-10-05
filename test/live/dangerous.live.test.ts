import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { OPENCODE } from '../../src/harness/acp/presets'
import { claudeFactory } from '../../src/harness/claude/factory'
import { codexFactory } from '../../src/harness/codex/factory'
import { loginEnv, which } from '../../src/harness/env'
import { HarnessManager } from '../../src/harness/manager'
import { configurePi, piFactory } from '../../src/harness/pi/factory'
import type { HarnessFactory } from '../../src/harness/types'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import type { Mode } from '../../src/shared/models'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

// In Dangerous mode a real agent must write a file and run a shell command with NO permission prompt, whether the mode was
// set when the session started or switched on afterwards. In Ask mode the same request must stop and ask.
const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
let session: AgentSession | null = null
beforeAll(() => { ws = makeTestWorkspace(); configurePi({ extensionPath: resolve('native/pi/asi-extension.js') }) })
afterAll(() => ws?.cleanup())
afterEach(async () => { await session?.dispose(); session = null; for (const f of ['danger.txt', 'ran.txt']) rmSync(join(ws.dir, f), { force: true }) })

const PROMPT = 'Do exactly two things. 1) Create a file named danger.txt containing the single word go, using your file write tool. 2) Run this shell command with your shell tool: echo ok > ran.txt. Then reply done.'

async function run(factory: HarnessFactory, over: Record<string, unknown>, startMode: Mode) {
  session = await factory({ friend: friendFor({ dangerousAllowed: true, ...over }) as never, chatId: 'c', cwd: ws.dir, mode: startMode })
  const c = collect(session)
  session.send({ text: PROMPT })
  // in Ask mode answer "allow once" so the turn can finish; we only care whether it asked
  for (let i = 0; i < 150 && !c.events.some((e) => e.t === 'turn_end'); i++) {
    for (const e of c.events) if (e.t === 'permission' && !(e as { seen?: boolean }).seen) { (e as { seen?: boolean }).seen = true; session.respond(e.reqId, 'allow-once') }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await c.until((e) => e.t === 'turn_end', 60_000)
  return { asked: c.events.filter((e) => e.t === 'permission').length, wrote: existsSync(join(ws.dir, 'danger.txt')), ran: existsSync(join(ws.dir, 'ran.txt')), events: c.events }
}

/**
 * The way the app does it: a HarnessManager owns the session. A first turn runs in Ask mode, then the mode is switched in the
 * middle of the conversation, then the real request goes out. Agents that only read their policy at launch must be restarted.
 */
async function runViaManager(factory: HarnessFactory, over: Record<string, unknown>) {
  const events: AgentEvent[] = []
  const manager = new HarnessManager({ onEvent: (_id, e) => events.push(e) })
  manager.register('x' as never, factory)
  const friend = friendFor({ dangerousAllowed: true, harness: 'x', ...over }) as never
  const chat = { id: 'c', harnessSessionId: null as string | null, mode: 'ask' as Mode } as never
  const waitEnd = async (n: number) => { for (let i = 0; i < 150 && events.filter((e) => e.t === 'turn_end').length < n; i++) { for (const e of events) if (e.t === 'permission' && !(e as { seen?: boolean }).seen) { (e as { seen?: boolean }).seen = true; manager.respond('c', e.reqId, 'allow-once') } await new Promise((r) => setTimeout(r, 1000)) } }
  try {
    await manager.send(chat, friend, ws.dir, { text: 'Reply with the single word ready.' })
    await waitEnd(1)
    const before = events.filter((e) => e.t === 'permission').length
    ;(chat as { mode: Mode }).mode = 'dangerous'
    manager.setMode('c', 'dangerous')
    await new Promise((r) => setTimeout(r, 500))
    await manager.send(chat, friend, ws.dir, { text: PROMPT })
    await waitEnd(2)
    return { asked: events.filter((e) => e.t === 'permission').length - before, wrote: existsSync(join(ws.dir, 'danger.txt')), ran: existsSync(join(ws.dir, 'ran.txt')), events }
  } finally { await manager.disposeAll() }
}

const AGENTS: { name: string; bin: string; make: () => HarnessFactory; over: Record<string, unknown> }[] = [
  { name: 'claude', bin: 'claude', make: () => claudeFactory, over: { harness: 'claude', args: ['--model', 'haiku'] } },
  { name: 'codex', bin: 'codex', make: () => codexFactory, over: { harness: 'codex' } },
  { name: 'opencode (ACP)', bin: 'opencode', make: () => acpFactory(OPENCODE), over: {} },
  { name: 'pi', bin: 'pi', make: () => piFactory, over: { harness: 'pi', args: ['--provider', 'openrouter', '--model', 'anthropic/claude-haiku-4.5'] } }
]

describe.skipIf(!live)('dangerous mode with real agents', async () => {
  const env = await loginEnv()
  for (const a of AGENTS) {
    const t = which(a.bin, env) ? test : test.skip
    t(`${a.name}: Ask mode asks first`, async () => {
      const r = await run(a.make(), a.over, 'ask')
      expect(r.asked).toBeGreaterThan(0)
    }, 300_000)
    t(`${a.name}: Dangerous from the start runs without asking`, async () => {
      const r = await run(a.make(), a.over, 'dangerous')
      expect(r.asked, JSON.stringify(r.events.filter((e) => e.t === 'permission'))).toBe(0)
      expect(r.wrote).toBe(true)
      expect(r.ran).toBe(true)
      expect(readFileSync(join(ws.dir, 'ran.txt'), 'utf8').trim()).toBe('ok')
    }, 300_000)
    t(`${a.name}: switching to Dangerous mid-chat takes effect`, async () => {
      const r = await runViaManager(a.make(), a.over)
      expect(r.asked, JSON.stringify(r.events.filter((e) => e.t === 'permission'))).toBe(0)
      expect(r.wrote && r.ran).toBe(true)
    }, 300_000)
  }
})
