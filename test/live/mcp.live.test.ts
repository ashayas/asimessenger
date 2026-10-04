import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { OPENCODE } from '../../src/harness/acp/presets'
import { claudeFactory } from '../../src/harness/claude/factory'
import { codexFactory } from '../../src/harness/codex/factory'
import { loginEnv, which } from '../../src/harness/env'
import type { HarnessFactory } from '../../src/harness/types'
import { createMcpBridge } from '../../src/main/mcp-bridge'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
let session: AgentSession | null = null
const asked: { q: string; choices?: string[] }[] = []
const attachments: string[] = []
const bridge = createMcpBridge({
  chatExists: async () => true,
  askUser: async (_id, q, choices) => { asked.push({ q, choices }); return 'Tangerine' },
  sendAttachment: async (_id, a) => { attachments.push(a.name) },
  openUrl: async () => {}, openDrawing: async () => {}, setStatus: async () => {}
})
beforeAll(async () => { ws = makeTestWorkspace(); await bridge.start() })
afterAll(async () => { ws?.cleanup(); await bridge.stop() })
afterEach(async () => { await session?.dispose(); session = null; asked.length = 0; attachments.length = 0 })

const text = (events: AgentEvent[]) => events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
const T = 180_000
const PROMPT = "Use the ask_user tool from the 'asi' MCP server to ask the human: 'What is the secret fruit?'. Then reply with exactly the answer the human gave, nothing else."

async function run(factory: HarnessFactory, friendOver: Record<string, unknown>) {
  session = await factory({ friend: friendFor(friendOver) as never, chatId: 'live-chat', cwd: ws.dir, mode: 'ask', mcp: bridge.endpointFor('live-chat') })
  const c = collect(session)
  session.send({ text: PROMPT })
  // an agent might also route the question through our permission UI; allow anything that is not a write
  for (let i = 0; i < 100; i++) {
    const done = c.events.some((e) => e.t === 'turn_end')
    if (done) break
    const req = c.events.find((e) => e.t === 'permission' && !('seen' in e)) as Extract<AgentEvent, { t: 'permission' }> | undefined
    if (req && !(req as unknown as { seen?: boolean }).seen) { (req as unknown as { seen: boolean }).seen = true; session.respond(req.reqId, 'allow-once') }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await c.until((e) => e.t === 'turn_end', T)
  return c
}

describe.skipIf(!live)('ASI MCP bridge with real agents', async () => {
  const env = await loginEnv()

  test.skipIf(!which('claude', env))('claude calls ask_user and relays the answer', async () => {
    const c = await run(claudeFactory, { harness: 'claude', args: ['--model', 'haiku'] })
    expect(asked[0]?.q).toContain('secret fruit')
    expect(text(c.events)).toContain('Tangerine')
  })

  test.skipIf(!which('opencode', env))('opencode calls ask_user and relays the answer', async () => {
    const c = await run(acpFactory(OPENCODE), {})
    expect(asked[0]?.q).toContain('secret fruit')
    expect(text(c.events)).toContain('Tangerine')
  })

  test.skipIf(!which('codex', env))('codex calls ask_user and relays the answer', async () => {
    const c = await run(codexFactory, { harness: 'codex' })
    expect(asked[0]?.q).toContain('secret fruit')
    expect(text(c.events)).toContain('Tangerine')
  })
})
