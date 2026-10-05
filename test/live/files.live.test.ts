import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { claudeFactory } from '../../src/harness/claude/factory'
import { codexFactory } from '../../src/harness/codex/factory'
import { loginEnv, which } from '../../src/harness/env'
import type { HarnessFactory } from '../../src/harness/types'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import { filePrompt } from '../../src/shared/attachments'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

// A csv that is NOT pasted into the prompt: the agent is only told where it is, and must open it to answer.
const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
let csv = ''
let session: AgentSession | null = null
beforeAll(() => {
  ws = makeTestWorkspace()
  mkdirSync(join(ws.dir, '.attachments', 'abc123'), { recursive: true })
  csv = join(ws.dir, '.attachments', 'abc123', 'sales.csv')
  writeFileSync(csv, 'region,amount\nnorth,1200\nsouth,3400\neast,560\nwest,7000\n')
})
afterAll(() => ws?.cleanup())
afterEach(async () => { await session?.dispose(); session = null })

const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

async function total(factory: HarnessFactory, over: Record<string, unknown>) {
  session = await factory({ friend: friendFor(over) as never, chatId: 'c', cwd: ws.dir, mode: 'ask' })
  const c = collect(session)
  session.send({ text: filePrompt('sales.csv', csv, statSync(csv).size, 'What is the total of the amount column? Answer with just the number.') })
  for (let i = 0; i < 180 && !c.events.some((e) => e.t === 'turn_end'); i++) {
    for (const e of c.events) if (e.t === 'permission' && !(e as { seen?: boolean }).seen) { (e as { seen?: boolean }).seen = true; session.respond(e.reqId, 'allow-once') }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await c.until((e) => e.t === 'turn_end', 60_000)
  return text(c.events).replace(/[,\s$]/g, '')
}

describe.skipIf(!live)('agents open an attached file from its path', async () => {
  const env = await loginEnv()
  test.skipIf(!which('claude', env))('claude reads the csv', async () => { expect(await total(claudeFactory, { harness: 'claude', args: ['--model', 'haiku'] })).toContain('12160') }, 240_000)
  test.skipIf(!which('codex', env))('codex reads the csv', async () => { expect(await total(codexFactory, { harness: 'codex' })).toContain('12160') }, 240_000)
})
