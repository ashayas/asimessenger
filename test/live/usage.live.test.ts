import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { claudeFactory } from '../../src/harness/claude/factory'
import { loginEnv, which } from '../../src/harness/env'
import { probeClaude, probeCodex } from '../../src/main/usage-probe'
import type { AgentEvent } from '../../src/shared/events'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
beforeAll(() => { ws = makeTestWorkspace() })
afterAll(() => ws?.cleanup())

describe.skipIf(!live)('real usage and limits', async () => {
  const env = await loginEnv()

  test.skipIf(!which('codex', env))('Codex reports plan windows and account usage without a model call', async () => {
    const r = await probeCodex({ command: which('codex', env)!, env })
    expect(r.limits!.windows.length).toBeGreaterThan(0)
    expect(r.limits!.windows.every((w) => w.usedPercent >= 0 && w.usedPercent <= 100)).toBe(true)
    expect(r.account!.lifetimeTokens).toBeGreaterThan(0)
    expect(r.account!.last14).toHaveLength(14)
  }, 60_000)

  test.skipIf(!which('claude', env))('Claude reports 5-hour and weekly windows, and a turn spends a delta, not a total', async () => {
    const p = await probeClaude({ command: which('claude', env)!, env })
    expect(p.limits.windows.map((w) => w.id)).toEqual(expect.arrayContaining(['five_hour', 'seven_day']))
    expect(p.usage!.costUsd).toBeGreaterThan(0)

    const s = await claudeFactory({ friend: friendFor({ harness: 'claude', args: ['--model', 'haiku'] }) as never, chatId: 'u', cwd: ws.dir, mode: 'ask' })
    const c = collect(s)
    for (const word of ['one', 'two']) {
      const n = c.events.filter((e) => e.t === 'turn_end').length
      s.send({ text: `Reply with the word ${word}.` })
      await c.until(() => c.events.filter((e) => e.t === 'turn_end').length === n + 1, 90_000)
    }
    await s.dispose()
    const u = c.events.filter((e) => e.t === 'usage') as Extract<AgentEvent, { t: 'usage' }>[]
    expect(u).toHaveLength(2)
    expect(u[0]!.costUsd).toBeGreaterThan(0)
    expect(u[1]!.costUsd).toBeGreaterThan(0)
    expect(u[1]!.costUsd!).toBeLessThan(u[0]!.costUsd! * 3) // a second tiny turn does not cost the running total again
    expect(c.events.some((e) => e.t === 'limits')).toBe(true)
  }, 240_000)
})
