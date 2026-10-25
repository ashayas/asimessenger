import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AgySession, toolKind } from '../../src/harness/agy/session'
import { addRule, cleanupStaleRules, removeRule, ruleFromDenial } from '../../src/harness/agy/rules'
import { MIGRATIONS } from '../../src/main/db/migrations'
import { openDb } from '../../src/main/db/db'
import type { AgentEvent } from '../../src/shared/events'
import type { Mode } from '../../src/shared/models'
import { collect } from './helpers'

const MOCK = resolve('test/fixtures/mock-agy.mjs')
let dir: string
let settings: string
let sessions: AgySession[] = []
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'asi-agy-')))
  settings = join(dir, 'cfg', 'settings.json')
  sessions = []
})
afterEach(async () => { for (const s of sessions) await s.dispose(); rmSync(dir, { recursive: true, force: true }) })

const make = async (mode: Mode = 'ask', over: Record<string, unknown> = {}) => {
  const s = await AgySession.create({ command: process.execPath, prefixArgs: [MOCK], env: { ...process.env, MOCK_AGY_SETTINGS: settings }, cwd: dir, mode, dangerousAllowed: true, settingsPath: settings, ...over })
  sessions.push(s)
  return { s, c: collect(s) }
}
const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
const turnEnds = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'turn_end')
const perms = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'permission') as Extract<AgentEvent, { t: 'permission' }>[]
const settingsJson = () => JSON.parse(readFileSync(settings, 'utf8')) as { permissions?: { allow?: string[] }; keep?: number }
const waitFor = async (pred: () => boolean, ms = 8000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)) } }

describe('Antigravity (agy) over stream-json', () => {
  test('missing executable fails promptly instead of waiting for the init timeout', async () => {
    await expect(make('ask', { command: join(dir, 'missing') })).rejects.toThrow(/failed to start agy/)
  }, 2000)

  test('whitespace deltas and result-only replies survive normalization', async () => {
    const { s, c } = await make()
    s.send({ text: 'whitespace' }); await waitFor(() => turnEnds(c.events).length === 1)
    expect(text(c.events)).toBe('hello world\n')
    s.send({ text: 'result-only' }); await waitFor(() => turnEnds(c.events).length === 2)
    expect(text(c.events)).toBe('hello world\nfallback reply')
  })

  test('an idle process exit is recovered on the next message', async () => {
    const { s, c } = await make()
    const id = s.resumeId
    s.send({ text: 'exit-idle' }); await c.turnEnd()
    await new Promise((r) => setTimeout(r, 100))
    s.send({ text: 'hello' }); await waitFor(() => turnEnds(c.events).length === 2)
    expect(turnEnds(c.events).at(-1)).toMatchObject({ reason: 'done' })
    expect(s.resumeId).toBe(id)
    expect(text(c.events)).toBe('byedone 1')
  })

  test('a resumed conversation reports per-step spend instead of cumulative history', async () => {
    const first = await make()
    first.s.send({ text: 'hello' }); await first.c.turnEnd()
    await first.s.dispose()
    const resumed = await make('ask', { resumeId: first.s.resumeId })
    resumed.s.send({ text: 'after reset' }); await resumed.c.turnEnd()
    expect(resumed.c.events.find(e => e.t === 'usage')).toMatchObject({ inputTokens: 100, outputTokens: 20 })
  })

  test('streams the reply, reports usage without counting thinking twice, and the conversation id is the resume id', async () => {
    const { s, c } = await make()
    expect(s.resumeId).toMatch(/^conv-/)
    s.send({ text: 'hello' })
    await c.turnEnd()
    expect(text(c.events)).toBe('done 1')
    expect(c.events.find((e) => e.t === 'usage')).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 })
    expect(turnEnds(c.events)[0]).toMatchObject({ reason: 'done' })
  })

  test('a second message continues the same process and conversation', async () => {
    const { s, c } = await make()
    s.send({ text: 'one' }); await waitFor(() => turnEnds(c.events).length === 1)
    s.send({ text: 'two' }); await waitFor(() => turnEnds(c.events).length === 2)
    expect(text(c.events)).toBe('done 1done 2')
    expect(c.events.filter((e) => e.t === 'usage')).toEqual([
      { t: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
      { t: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 }
    ])
  })

  test('resuming passes --conversation', async () => {
    const { s, c } = await make('ask', { resumeId: 'conv-abc' })
    expect(s.resumeId).toBe('conv-abc')
    s.send({ text: 'flags' }); await c.turnEnd()
    expect(text(c.events)).toContain('--conversation conv-abc')
  })

  test('mode becomes launch flags: Dangerous skips permissions (only when the friend allows it), Plan plans, Ask adds none', async () => {
    for (const [mode, expected] of [['dangerous', '--dangerously-skip-permissions'], ['plan', '--mode plan'], ['auto-edit', '--mode accept-edits']] as const) {
      const { s, c } = await make(mode)
      s.send({ text: 'flags' }); await c.turnEnd()
      expect(text(c.events)).toContain(expected)
    }
    const { s, c } = await make('ask')
    s.send({ text: 'flags' }); await c.turnEnd()
    expect(text(c.events)).not.toMatch(/dangerously|--mode/)
    await expect(make('dangerous', { dangerousAllowed: false })).rejects.toThrow(/not enabled/)
  })

  test('it asks the manager to start fresh (rather than ignore it) when the mode changes', async () => {
    const { s } = await make()
    expect(s.restartOnModeChange).toBe(true)
  })

  test('tool steps become tool events with the right kind, command and file', async () => {
    expect(['write_to_file', 'run_command', 'view_file', 'grep_search', 'browser_get_dom', 'call_mcp_tool'].map(toolKind)).toEqual(['edit', 'exec', 'read', 'search', 'web', 'mcp'])
    const { s, c } = await make('dangerous')
    s.send({ text: `write ${join(dir, 'a.txt')} and run \`echo ok\`` }); await c.turnEnd()
    const tools = c.events.filter((e) => e.t === 'tool' && e.done && e.exit === 0) as Extract<AgentEvent, { t: 'tool' }>[]
    expect(tools.map((t) => [t.kind, t.command ?? t.files?.[0]?.path])).toEqual([['edit', join(dir, 'a.txt')], ['exec', 'echo ok']])
    expect(tools[0]).toMatchObject({ output: 'mock tool output', durationMs: 10 })
    expect(perms(c.events)).toHaveLength(0)
  })

  test('agent-reported cancellation is an interruption, not an error', async () => {
    const { s, c } = await make()
    s.send({ text: 'cancelled-result' }); await c.turnEnd()
    expect(turnEnds(c.events)[0]).toMatchObject({ reason: 'interrupted' })
  })
})

describe('Ask mode: headless agy cannot prompt, so denied actions become cards you can approve', () => {
  const target = () => join(dir, 'a.txt')

  test('result denial plus an unscoped tool error still yields the exact command approval', async () => {
    const { s, c } = await make('ask', { env: { ...process.env, MOCK_AGY_SETTINGS: settings, MOCK_AGY_DENIAL_ERROR: '1' } })
    s.send({ text: 'run `python3 -c "print(271828)"`' })
    await waitFor(() => perms(c.events).length === 1)
    expect(perms(c.events)[0]).toMatchObject({ tool: 'exec', summary: 'python3 -c "print(271828)"' })
    expect(c.events.filter(e => e.t === 'tool').at(-1)).toMatchObject({ output: 'Not allowed yet: command(python3 -c "print(271828)")' })
  })

  test('a denied write ends the turn, then asks; Deny leaves everything as it was', async () => {
    const { s, c } = await make('ask')
    s.send({ text: `write ${target()}` }); await waitFor(() => perms(c.events).length === 1)
    expect(turnEnds(c.events)).toHaveLength(1)
    expect(perms(c.events)[0]).toMatchObject({ tool: 'edit', summary: target() })
    expect(perms(c.events)[0]!.options.map((o) => o.id)).toEqual(['allow-once', 'allow-chat', 'deny'])
    const denied = c.events.find((e) => e.t === 'tool' && e.output?.startsWith('Not allowed yet')) as Extract<AgentEvent, { t: 'tool' }>
    expect(denied.output).toContain('Not allowed yet')
    s.respond(perms(c.events)[0]!.reqId, 'deny')
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(settings)).toBe(false) // no rule was ever added
    expect(turnEnds(c.events)).toHaveLength(1)
  })

  test('Allow once adds exactly that rule, resumes the conversation in a fresh process, retries, then removes the rule', async () => {
    mkdirSync(join(dir, 'cfg'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ keep: 1, permissions: { allow: ['command(git log)'] } }, null, 2))
    const { s, c } = await make('ask')
    const convo = s.resumeId
    s.send({ text: `write ${target()}` }); await waitFor(() => perms(c.events).length === 1)
    s.respond(perms(c.events)[0]!.reqId, 'allow-once')
    await waitFor(() => turnEnds(c.events).length === 2)
    const rule = `write_file(${target()})`
    expect(c.events.filter((e) => e.t === 'tool' && e.done && e.exit === 0)).toHaveLength(1) // the retry went through
    expect(s.resumeId).toBe(convo) // same conversation, new process
    expect(perms(c.events)).toHaveLength(1)
    s.send({ text: `write ${target()}` })
    await waitFor(() => perms(c.events).length === 2) // a cached allow-once grant cannot authorize the next turn
    await waitFor(() => !(settingsJson().permissions?.allow ?? []).includes(rule)) // gone again once the turn is over
    expect(settingsJson()).toEqual({ keep: 1, permissions: { allow: ['command(git log)'] } }) // everything else untouched
  })

  test('Allow for this chat keeps the rule until the chat ends, and a command asks with its own text', async () => {
    const { s, c } = await make('ask')
    s.send({ text: 'run `git status`' }); await waitFor(() => perms(c.events).length === 1)
    expect(perms(c.events)[0]).toMatchObject({ tool: 'exec', summary: 'git status' })
    s.respond(perms(c.events)[0]!.reqId, 'allow-chat')
    await waitFor(() => turnEnds(c.events).length === 2)
    expect(settingsJson().permissions!.allow).toEqual(['command(git status)'])
    s.send({ text: 'run `git status`' }); await waitFor(() => turnEnds(c.events).length === 3) // no second question
    expect(perms(c.events)).toHaveLength(1)
    await s.dispose()
    expect(existsSync(settings)).toBe(false) // a settings file we created is removed with our last rule
  })

  test('Auto-edit approves edits by itself in one continuous turn, and still asks about commands', async () => {
    const { s, c } = await make('auto-edit')
    s.send({ text: `write ${target()} and run \`rm -rf dist\`` })
    await waitFor(() => perms(c.events).length === 1)
    expect(perms(c.events)[0]).toMatchObject({ tool: 'exec', summary: 'rm -rf dist' })
    expect(c.events.filter((e) => e.t === 'tool' && e.kind === 'edit' && e.done && e.exit === 0)).toHaveLength(1) // the edit went through on its own
    expect(turnEnds(c.events)).toHaveLength(1) // one turn from your side: the edit retry was not reported as a separate turn
    const left = existsSync(settings) ? (settingsJson().permissions?.allow ?? []) : []
    expect(left).not.toContain(`write_file(${target()})`) // and its rule was already taken back
  })

  test('Stop cancels the turn and any waiting cards; the session stays usable', async () => {
    const { s, c } = await make('ask')
    s.send({ text: 'slow' }); await waitFor(() => c.events.some((e) => e.t === 'tool'))
    await s.interrupt()
    expect(turnEnds(c.events).at(-1)).toMatchObject({ reason: 'interrupted' })
    s.send({ text: 'hello' }); await waitFor(() => turnEnds(c.events).length === 2)
    expect(turnEnds(c.events).at(-1)).toMatchObject({ reason: 'done' })
  })
})

describe('allow-rules in agy’s settings', () => {
  test('concurrent grants and releases do not overwrite each other', async () => {
    const rules = Array.from({ length: 10 }, (_, i) => `command(echo ${i})`)
    await Promise.all(rules.map((r) => addRule(settings, r)))
    expect(settingsJson().permissions!.allow?.sort()).toEqual(rules.sort())
    await Promise.all(rules.map((r) => removeRule(settings, r)))
    expect(existsSync(settings)).toBe(false)
  })

  test('pre-existing user rules survive a grant and release', async () => {
    mkdirSync(join(dir, 'cfg'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['command(mine)'] } }))
    await addRule(settings, 'command(mine)')
    await removeRule(settings, 'command(mine)')
    expect(settingsJson().permissions!.allow).toEqual(['command(mine)'])
  })

  test('the same rule in different settings files has independent ownership', async () => {
    const other = join(dir, 'other', 'settings.json')
    await Promise.all([addRule(settings, 'command(same)'), addRule(other, 'command(same)')])
    expect(JSON.parse(readFileSync(other, 'utf8')).permissions.allow).toEqual(['command(same)'])
    await removeRule(settings, 'command(same)')
    expect(existsSync(settings)).toBe(false)
    expect(existsSync(other)).toBe(true)
    await removeRule(other, 'command(same)')
    expect(existsSync(other)).toBe(false)
  })

  test('rules are counted: two holders of the same rule, and it goes only when both let go; unrelated settings survive', async () => {
    mkdirSync(join(dir, 'cfg'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ model: 'x', permissions: { allow: ['command(head)'] } }))
    await addRule(settings, 'write_file(/p/a)'); await addRule(settings, 'write_file(/p/a)')
    expect(settingsJson().permissions!.allow).toEqual(['command(head)', 'write_file(/p/a)'])
    await removeRule(settings, 'write_file(/p/a)')
    expect(settingsJson().permissions!.allow).toContain('write_file(/p/a)')
    await removeRule(settings, 'write_file(/p/a)')
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ model: 'x', permissions: { allow: ['command(head)'] } })
  })

  test('a rule left behind by a crashed run is cleaned up by the next one', async () => {
    mkdirSync(join(dir, 'cfg'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ model: 'x' }))
    await addRule(settings, 'command(echo hi)')
    // simulate a crash: this process forgets it holds the rule, but the journal on disk remembers
    const { refsForTest } = await import('../../src/harness/agy/rules').then((m) => ({ refsForTest: m }))
    void refsForTest
    await removeRule(settings, 'command(echo hi)') // clean state first
    writeFileSync(join(dir, 'cfg', 'asi-messenger-temp-rules.json'), JSON.stringify({ rules: ['command(left behind)'], createdFile: false }))
    writeFileSync(settings, JSON.stringify({ model: 'x', permissions: { allow: ['command(left behind)', 'command(mine)'] } }))
    await cleanupStaleRules(settings)
    expect(settingsJson().permissions!.allow).toEqual(['command(mine)'])
    expect(existsSync(join(dir, 'cfg', 'asi-messenger-temp-rules.json'))).toBe(false)
  })

  test('the rule agy needs is read from its own denial message', () => {
    expect(ruleFromDenial('permission check failed for write_file "/private/tmp/a.txt": user denied permission for write_file(/private/tmp/a.txt)\nDo not attempt to circumvent')).toBe('write_file(/private/tmp/a.txt)')
    expect(ruleFromDenial('user denied permission for command(echo ok > b.txt)')).toBe('command(echo ok > b.txt)')
    expect(ruleFromDenial('some other failure')).toBeNull()
  })
})

describe('Gemini CLI is replaced by Antigravity for existing users', () => {
  test('migration 10 turns a Gemini friend into Antigravity and clears its old session ids, leaving others alone', async () => {
    const db = await openDb(':memory:')
    try {
      await db.execute("INSERT INTO workspaces(id,name,path,slot) VALUES ('w','w','/tmp',1)")
      const friend = (id: string, harness: string, transport: string | null, name: string) => db.execute({ sql: "INSERT INTO friends(id,harness,display_name,avatar,command,args_json,transport,default_mode,dangerous_allowed,lettering_style,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: [id, harness, name, transport ?? harness, transport ?? harness, '["--experimental-acp"]', transport, 'ask', 0, 'funky', 1] })
      await friend('g', 'acp', 'gemini', 'Gemini CLI'); await friend('o', 'acp', 'opencode', 'OpenCode'); await friend('gx', 'acp', 'gemini', 'My Gemini')
      for (const [c, f] of [['cg', 'g'], ['co', 'o']] as const) await db.execute({ sql: "INSERT INTO chats(id,workspace_id,friend_id,title,harness_session_id,created_at,last_activity_at) VALUES (?,?,?,?,?,1,1)", args: [c, 'w', f, 't', 'old-session'] })
      await db.executeMultiple(MIGRATIONS.at(-1)!)
      const rows = (await db.execute('SELECT id, harness, transport, command, args_json, avatar, display_name FROM friends ORDER BY id')).rows
      expect(rows.find((r) => r['id'] === 'g')).toMatchObject({ harness: 'agy', transport: null, command: 'agy', args_json: '[]', avatar: 'agy', display_name: 'Antigravity' })
      expect(rows.find((r) => r['id'] === 'gx')).toMatchObject({ harness: 'agy', display_name: 'My Gemini' }) // a name you chose is kept
      expect(rows.find((r) => r['id'] === 'o')).toMatchObject({ harness: 'acp', transport: 'opencode' })
      const chats = (await db.execute('SELECT id, harness_session_id FROM chats ORDER BY id')).rows
      expect(chats.find((r) => r['id'] === 'cg')!['harness_session_id']).toBeNull()
      expect(chats.find((r) => r['id'] === 'co')!['harness_session_id']).toBe('old-session')
    } finally { db.close() }
  })
})
