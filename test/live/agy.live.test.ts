import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { agyFactory } from '../../src/harness/agy/factory'
import { HarnessManager } from '../../src/harness/manager'
import type { AgentEvent } from '../../src/shared/events'
import type { Chat, Mode } from '../../src/shared/models'
import { friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

let manager: HarnessManager | undefined
let ws: ReturnType<typeof makeTestWorkspace> | undefined
afterEach(async () => { await manager?.disposeAll(); ws?.cleanup() })

describe.skipIf(!process.env['ASI_LIVE'])('installed Antigravity stream-json contract', () => {
  test('replies, resumes through mode switches, and bypass really permits file and shell tools', async () => {
    ws = makeTestWorkspace()
    const events: AgentEvent[] = []
    const chat = { id: 'agy-live', mode: 'ask' as Mode, harnessSessionId: null as string | null } as Chat
    const friend = friendFor({ harness: 'agy', command: 'agy', args: ['--model', 'gemini-3.8-flash-low'], dangerousAllowed: true })
    manager = new HarnessManager({ onEvent: (_, e) => events.push(e), onResumeId: (_, id) => { chat.harnessSessionId = id } })
    manager.register('agy', agyFactory)
    const turn = async (text: string) => {
      const start = events.length
      await manager!.send(chat, friend, ws!.dir, { text })
      const deadline = Date.now() + 90_000
      while (!events.slice(start).some((e) => e.t === 'turn_end') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      const result = events.slice(start)
      expect(result.find((e) => e.t === 'turn_end')).toMatchObject({ reason: 'done' })
      return result
    }
    const first = await turn('Reply with exactly ASI_AGY_READY. Do not use tools.')
    expect(first.filter((e) => e.t === 'text').map((e) => e.delta).join('')).toContain('ASI_AGY_READY')
    const id = chat.harnessSessionId
    chat.mode = 'dangerous'; manager.setMode(chat.id, chat.mode)
    const result = await turn('In this scratch folder use your file write tool to create danger.txt containing OK. Then use your shell tool to run: printf OK > ran.txt. Do both, then reply done.')
    expect(result.filter((e) => e.t === 'permission')).toHaveLength(0)
    expect(readFileSync(join(ws.dir, 'danger.txt'), 'utf8').trim()).toBe('OK')
    expect(readFileSync(join(ws.dir, 'ran.txt'), 'utf8').trim()).toBe('OK')
    expect(chat.harnessSessionId).toBe(id)
    chat.mode = 'auto-edit'; manager.setMode(chat.id, chat.mode)
    const edits = await turn('Use your file write tool to create auto.txt containing AUTO. Do not use shell tools. Reply done.')
    expect(edits.filter((e) => e.t === 'permission')).toHaveLength(0)
    expect(readFileSync(join(ws.dir, 'auto.txt'), 'utf8').trim()).toBe('AUTO')
  }, 240_000)
  test('Ask presents a soft denial, Allow once retries the exact command, and resets clear grants', async () => {
    ws = makeTestWorkspace()
    const events: AgentEvent[] = []
    const chat = { id: 'agy-approval', mode: 'ask', harnessSessionId: null } as Chat
    const friend = friendFor({ harness: 'agy', command: 'agy', args: ['--model', 'gemini-3.8-flash-low'] })
    manager = new HarnessManager({ onEvent: (_, e) => events.push(e), onResumeId: (_, id) => { chat.harnessSessionId = id } })
    manager.register('agy', agyFactory)
    const output = join(ws.dir, 'approved.txt')
    await manager.send(chat, friend, ws.dir, { text: `Use run_command to run exactly: python3 -c "from pathlib import Path; Path('${output}').write_text('APPROVED')". Do not substitute other tools or commands.` })
    const deadline = Date.now() + 100_000
    while (!events.some(e => e.t === 'permission') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    const permission = events.find(e => e.t === 'permission')
    expect(permission, JSON.stringify(events)).toBeDefined()
    expect(existsSync(output)).toBe(false)
    if (permission?.t !== 'permission') throw new Error('missing approval')
    const start = events.length
    manager.respond(chat.id, permission.reqId, 'allow-once')
    while (!events.slice(start).some(e => e.t === 'turn_end') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(readFileSync(output, 'utf8')).toBe('APPROVED')
    expect(events.slice(start).find(e => e.t === 'turn_end')).toMatchObject({ reason: 'done' })
    await manager.dispose(chat.id)
    const next = events.length
    await manager.send(chat, friend, ws.dir, { text: 'Reply with exactly AFTER_RESET. Do not use tools.' })
    while (!events.slice(next).some(e => e.t === 'turn_end') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(events.slice(next).filter(e => e.t === 'text').map(e => e.delta).join('')).toContain('AFTER_RESET')
  }, 150_000)

  test('usage after reset reports this turn rather than the conversation total', async () => {
    ws = makeTestWorkspace()
    const events: AgentEvent[] = []
    const chat = { id: 'agy-usage', mode: 'ask', harnessSessionId: null } as Chat
    const friend = friendFor({ harness: 'agy', command: 'agy', args: ['--model', 'gemini-3.8-flash-low'] })
    manager = new HarnessManager({ onEvent: (_, e) => events.push(e), onResumeId: (_, id) => { chat.harnessSessionId = id } })
    manager.register('agy', agyFactory)
    const spent: number[] = []
    for (let n = 0; n < 3; n++) {
      const start = events.length
      await manager.send(chat, friend, ws.dir, { text: 'Reply with exactly OK. Do not use tools.' })
      const deadline = Date.now() + 90_000
      while (!events.slice(start).some(e => e.t === 'turn_end') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
      expect(events.slice(start).find(e => e.t === 'turn_end')).toMatchObject({ reason: 'done' })
      const usage = events.slice(start).filter(e => e.t === 'usage')
      expect(usage).toHaveLength(1)
      spent.push(usage[0]!.inputTokens)
      expect(usage[0]!.outputTokens).toBeGreaterThan(0)
      await manager.dispose(chat.id)
    }
    expect(spent[0]).toBeGreaterThan(0)
    expect(spent[1]).toBeLessThan(spent[0]! * 1.5)
    expect(spent[2]).toBeLessThan(spent[0]! * 1.5)
  }, 300_000)

})
