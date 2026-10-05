import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { ClaudeSession } from '../../src/harness/claude/session'
import { mapClaudeRateLimit } from '../../src/harness/claude/limits'
import { CodexSession } from '../../src/harness/codex/session'
import { codexUsageDelta, mapCodexRateLimits } from '../../src/harness/codex/limits'
import { PiSession } from '../../src/harness/pi/session'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import { createUsageService } from '../../src/main/usage-service'
import { fmtAgo, fmtCost, fmtReset, fmtTokens, labelForMinutes, totalTokens, windowIsStale } from '../../src/shared/usage'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import { collect, friendFor } from './helpers'

const usages = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'usage') as Extract<AgentEvent, { t: 'usage' }>[]
const limits = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'limits') as Extract<AgentEvent, { t: 'limits' }>[]

describe('formatting', () => {
  test('tokens, cost, resets and ages read at a glance', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(34_500)).toBe('35k')
    expect(fmtTokens(5_600_000)).toBe('5.6M')
    expect(fmtTokens(761_086_938)).toBe('761M')
    expect(fmtTokens(2_100_000_000)).toBe('2.1B')
    expect(fmtCost(0)).toBe('$0.00')
    expect(fmtCost(0.004)).toBe('<$0.01')
    expect(fmtCost(3.412)).toBe('$3.41')
    expect(fmtCost(1234.5)).toBe('$1,235')
    const now = 1_000_000_000_000
    expect(fmtReset(now / 1000 + 90, now)).toBe('in 2m')
    expect(fmtReset(now / 1000 + 3 * 3600 + 12 * 60, now)).toBe('in 3h 12m')
    expect(fmtReset(now / 1000 + 3 * 86400 + 4 * 3600, now)).toBe('in 3d 4h')
    expect(fmtReset(now / 1000 - 5, now)).toBe('reset')
    expect(fmtReset(null, now)).toBe('')
    expect(fmtAgo(now - 30_000, now)).toBe('just now')
    expect(fmtAgo(now - 7 * 60_000, now)).toBe('7m ago')
    expect(fmtAgo(now - 5 * 3600_000, now)).toBe('5h ago')
    expect(windowIsStale({ id: 'x', label: 'x', usedPercent: 50, resetsAt: now / 1000 - 1 }, now)).toBe(true)
    expect(windowIsStale({ id: 'x', label: 'x', usedPercent: 50, resetsAt: null }, now)).toBe(false)
    expect(labelForMinutes(300)).toEqual({ id: 'five_hour', label: '5-hour' })
    expect(labelForMinutes(10080)).toEqual({ id: 'seven_day', label: 'Weekly' })
    expect(labelForMinutes(2880).label).toBe('2-day')
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10)
  })
})

describe('what each agent reports', () => {
  test('Claude: window utilisation becomes percentages; nothing without windows', () => {
    const ev = mapClaudeRateLimit({ status: 'allowed', isUsingOverage: true, unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 1791178800 }, seven_day: { utilization: 0.57, resetsAt: 1791302400 } } })!
    expect(ev.windows).toEqual([{ id: 'five_hour', label: '5-hour', usedPercent: 34, resetsAt: 1791178800 }, { id: 'seven_day', label: 'Weekly', usedPercent: 57, resetsAt: 1791302400 }])
    expect(ev).toMatchObject({ provider: 'claude', status: 'allowed', note: 'using extra usage' })
    expect(mapClaudeRateLimit({ status: 'allowed' })).toBeNull()
  })

  test('Codex: primary and secondary windows, plan, credits, and a reached limit', () => {
    const rl = { primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1791183407 }, secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1791661437 }, credits: { hasCredits: true, unlimited: false, balance: '25' }, planType: 'plus', rateLimitReachedType: null, spendControlReached: false }
    expect(mapCodexRateLimits(rl)).toMatchObject({ provider: 'codex', plan: 'plus', status: 'allowed', note: '25 credits', windows: [{ id: 'five_hour', usedPercent: 2 }, { id: 'seven_day', label: 'Weekly', usedPercent: 19 }] })
    expect(mapCodexRateLimits({ ...rl, rateLimitReachedType: 'primary' })!.status).toBe('primary')
    expect(mapCodexRateLimits({ primary: null, secondary: null })).toBeNull()
    expect(mapCodexRateLimits(null)).toBeNull()
  })

  test('Codex counters: input includes cached tokens, and deltas never go negative', () => {
    expect(codexUsageDelta({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 20 }, null)).toEqual({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 5 })
    expect(codexUsageDelta({ inputTokens: 250, cachedInputTokens: 150, outputTokens: 50 }, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20 })).toEqual({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 0 })
    expect(codexUsageDelta({ inputTokens: 10, outputTokens: 1 }, { inputTokens: 100, outputTokens: 20 }).inputTokens).toBe(0)
  })
})

describe('adapters publish what a turn spent, not running totals', () => {
  let s: AgentSession | null = null
  afterEach(async () => { await s?.dispose(); s = null })
  const twoTurns = async (session: AgentSession) => {
    const c = collect(session)
    for (let i = 1; i <= 2; i++) { session.send({ text: `hello ${i}` }); await c.until(() => c.events.filter((e) => e.t === 'turn_end').length === i, 10_000) }
    return c.events
  }

  test('Claude: cost is the difference of the session total; cache tokens and limits come through', async () => {
    s = new ClaudeSession({ command: process.execPath, env: process.env, cwd: process.cwd(), mode: 'ask', dangerousAllowed: false, prefixArgs: [resolve('test/fixtures/mock-claude.mjs')] })
    const ev = await twoTurns(s)
    const u = usages(ev)
    expect(u).toHaveLength(2)
    expect(u[0]).toMatchObject({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1000, cacheWriteTokens: 200, model: 'claude-haiku-4-5' })
    expect(u[0]!.costUsd).toBeCloseTo(0.001, 6)
    expect(u[1]!.costUsd).toBeCloseTo(0.001, 6) // total 0.002 minus the 0.001 already counted
    expect(limits(ev)).toHaveLength(2)
    expect(limits(ev)[0]!.windows.map((w) => w.usedPercent)).toEqual([31, 50])
  })

  test('Codex: per-update deltas, fresh input separated from cached, and limits seeded then updated', async () => {
    s = await CodexSession.create({ command: process.execPath, prefixArgs: [resolve('test/fixtures/mock-codex.mjs')], env: process.env, cwd: process.cwd(), mode: 'ask' })
    const ev = await twoTurns(s)
    const u = usages(ev)
    expect(u).toHaveLength(2)
    for (const x of u) expect(x).toMatchObject({ inputTokens: 40, cacheReadTokens: 60, outputTokens: 20 }) // 100 input of which 60 cached, 20 out, each turn
    const l = limits(ev)
    expect(l.length).toBeGreaterThanOrEqual(3) // seed + one per turn
    expect(l[0]).toMatchObject({ provider: 'codex', plan: 'plus', note: '25 credits' })
    expect(l.at(-1)!.windows[0]!.usedPercent).toBe(14)
  })

  test('ACP: one usage per prompt from the result, never from context-size updates', async () => {
    s = await acpFactory({ command: process.execPath, args: [resolve('test/fixtures/mock-acp-agent.mjs')] })({ friend: friendFor() as never, chatId: 'c', cwd: process.cwd(), mode: 'ask' })
    const c = collect(s)
    s.send({ text: 'hello' }); await c.turnEnd()
    expect(usages(c.events)).toEqual([{ t: 'usage', inputTokens: 5, outputTokens: 2, cacheReadTokens: undefined, cacheWriteTokens: undefined }])
  })

  test('Pi: each assistant message adds its own tokens and cost', async () => {
    s = new PiSession({ command: process.execPath, prefixArgs: [resolve('test/fixtures/mock-pi.mjs')], env: process.env, cwd: process.cwd(), mode: 'ask', dangerousAllowed: false, sessionFile: '/tmp/u.jsonl', extensionPath: '/x.js' })
    const c = collect(s)
    s.send({ text: 'hello' }); await c.turnEnd()
    expect(usages(c.events)).toEqual([{ t: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined, costUsd: 0.001, model: undefined }])
  })
})

describe('recording and reading usage', () => {
  let db: Db
  let repo: Repo
  beforeEach(async () => { db = await openDb(':memory:'); repo = createRepo(db) })
  afterEach(() => db.close())

  const rec = (o: Partial<Parameters<Repo['usage']['record']>[0]> = {}) => repo.usage.record({ chatId: 'c1', chatTitle: 'auth', friendId: 'f1', friendName: 'Claude Code', workspaceId: 'w1', workspaceName: 'honeycomb', inputTokens: 100, outputTokens: 50, costUsd: 0.02, ...o })

  test('totals add up, cost counts only priced calls, and a chat filter narrows them', async () => {
    await rec(); await rec({ costUsd: null, inputTokens: 10, outputTokens: 5, cacheReadTokens: 1000 }); await rec({ chatId: 'c2', inputTokens: 1, outputTokens: 1 })
    expect(await repo.usage.totals()).toEqual({ inputTokens: 111, outputTokens: 56, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.04, calls: 3, pricedCalls: 2 })
    expect(await repo.usage.totals(0, 'c1')).toMatchObject({ inputTokens: 110, calls: 2, pricedCalls: 1 })
  })

  test('a window excludes older calls', async () => {
    const now = Date.now()
    await rec({ ts: now - 10 * 86_400_000, inputTokens: 999 }); await rec({ ts: now - 1000 })
    expect((await repo.usage.totals(now - 86_400_000)).inputTokens).toBe(100)
    expect((await repo.usage.totals(0)).inputTokens).toBe(1099)
  })

  test('grouped by agent, workspace and chat, biggest first, with the newest name', async () => {
    await rec({ ts: 1000, chatTitle: 'old name' }); await rec({ ts: 2000, chatTitle: 'new name' })
    await rec({ friendId: 'f2', friendName: 'Codex', workspaceId: 'w2', workspaceName: 'fantasy', chatId: 'c9', chatTitle: 'epub', inputTokens: 5000, outputTokens: 0, costUsd: null })
    const byFriend = await repo.usage.grouped('friend')
    expect(byFriend.map((g) => g.label)).toEqual(['Codex', 'Claude Code'])
    expect(byFriend[0]).toMatchObject({ pricedCalls: 0, calls: 1 })
    expect((await repo.usage.grouped('workspace')).map((g) => g.label)).toEqual(['fantasy', 'honeycomb'])
    expect((await repo.usage.grouped('chat')).find((g) => g.key === 'c1')!.label).toBe('new name')
  })

  test('daily buckets are local days, oldest first, zero-filled', async () => {
    const now = new Date(2026, 9, 15, 15, 0, 0).getTime()
    await rec({ ts: now - 1000, inputTokens: 100, outputTokens: 0 }); await rec({ ts: now - 2 * 86_400_000, inputTokens: 40, outputTokens: 0, costUsd: 0.5 })
    const d = await repo.usage.daily(5, now)
    expect(d.map((x) => x.day)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
    expect(d.map((x) => x.tokens)).toEqual([0, 0, 40, 0, 100])
    expect(d[2]!.costUsd).toBe(0.5)
  })

  test('spend survives deleting the chat, and reset forgets it', async () => {
    const ws = await repo.workspaces.create({ name: 'w', path: '/tmp' })
    const f = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
    const c = await repo.chats.create({ workspaceId: ws.id, friendId: f.id })
    await rec({ chatId: c.id })
    await repo.chats.remove(c.id)
    expect((await repo.usage.totals()).calls).toBe(1)
    await repo.usage.reset()
    expect((await repo.usage.totals()).calls).toBe(0)
  })

  test('ingest records a usage event with the current names, and stores limits as of now', async () => {
    const ingestor = createIngestor(repo, () => {})
    const ws = await repo.workspaces.create({ name: 'honeycomb', path: '/tmp' })
    const f = await repo.friends.create({ harness: 'claude', displayName: 'Claude Code' })
    const c = await repo.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'auth refactor' })
    await ingestor.ingest(c.id, { t: 'usage', inputTokens: 3, outputTokens: 2, cacheReadTokens: 1000, costUsd: 0.01, model: 'claude-haiku-4-5' })
    await ingestor.ingest(c.id, { t: 'limits', provider: 'claude', windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 34, resetsAt: 1791178800 }], status: 'allowed' })
    expect((await repo.usage.grouped('chat'))[0]).toMatchObject({ key: c.id, label: 'auth refactor', inputTokens: 3, cacheReadTokens: 1000 })
    expect((await repo.usage.grouped('friend'))[0]!.label).toBe('Claude Code')
    const stored = await repo.settings.get<{ windows: unknown[]; asOf: number } | null>('limits:claude', null)
    expect(stored!.windows).toHaveLength(1)
    expect(Date.now() - stored!.asOf).toBeLessThan(5000)
  })
})

describe('the usage service', () => {
  let db: Db
  let repo: Repo
  beforeEach(async () => { db = await openDb(':memory:'); repo = createRepo(db) })
  afterEach(() => db.close())
  const svc = (probe: Record<string, unknown> | null = null) => {
    const topics: string[] = []
    const s = createUsageService({
      repo, notify: (t) => topics.push(t),
      probeOptions: async (p) => (probe === null ? null : p === 'codex' ? { command: process.execPath, env: process.env, prefixArgs: [resolve('test/fixtures/mock-codex.mjs')] } : { command: process.execPath, env: process.env, prefixArgs: [resolve('test/fixtures/mock-claude-print.mjs'), ...(probe['fail'] ? ['--fail'] : [])] })
    })
    return { s, topics }
  }

  test('overview combines spend by window, groups, daily chart and the stored limits', async () => {
    await repo.usage.record({ chatId: 'c', friendName: 'Claude Code', friendId: 'f', inputTokens: 100, outputTokens: 50, costUsd: 0.5 })
    await repo.usage.record({ chatId: 'c', friendName: 'Claude Code', friendId: 'f', inputTokens: 10, outputTokens: 5, ts: Date.now() - 20 * 86_400_000 })
    const { s } = svc()
    const o = await s.overview('week')
    expect(totalTokens(o.today)).toBe(150)
    expect(totalTokens(o.week)).toBe(150)
    expect(totalTokens(o.month)).toBe(165)
    expect(totalTokens(o.all)).toBe(165)
    expect(o.byFriend).toHaveLength(1)
    expect(o.daily).toHaveLength(14)
    expect(o.limits).toEqual([])
    expect(o.codexAccount).toBeNull()
  })

  test('refreshing Codex reads the plan limits and the whole-account usage without a model call', async () => {
    const { s, topics } = svc({})
    await s.refresh('codex')
    const o = await s.overview()
    expect(o.limits.map((l) => l.provider)).toEqual(['codex'])
    expect(o.limits[0]).toMatchObject({ plan: 'plus', windows: [{ usedPercent: 12 }, { usedPercent: 40 }] })
    expect(o.codexAccount).toMatchObject({ lifetimeTokens: 761086938, peakDailyTokens: 164959675 })
    expect(o.codexAccount!.last14).toHaveLength(14)
    expect(o.codexAccount!.last14.at(-1)!.tokens).toBe(5000)
    expect((await repo.usage.totals()).calls).toBe(0) // nothing is spent to read it
    expect(topics).toContain('usage')
  })

  test('refreshing Claude stores the windows and records the tiny request it cost', async () => {
    const { s } = svc({})
    await s.refresh('claude')
    const o = await s.overview()
    expect(o.limits[0]).toMatchObject({ provider: 'claude', windows: [{ id: 'five_hour', usedPercent: 34 }, { id: 'seven_day', usedPercent: 57 }] })
    expect(o.all).toMatchObject({ calls: 1, cacheReadTokens: 20000, costUsd: 0.014 })
    expect(o.byFriend[0]!.label).toBe('Claude Code')
  })

  test('a missing CLI and a signed-out CLI say so', async () => {
    await expect(svc(null).s.refresh('codex')).rejects.toThrow(/not installed/)
    await expect(svc({ fail: true }).s.refresh('claude')).rejects.toThrow(/Not logged in/)
  })

  test('reset forgets spend but keeps limits', async () => {
    const { s } = svc({})
    await s.refresh('codex')
    await repo.usage.record({ chatId: 'c', inputTokens: 1, outputTokens: 1 })
    await s.reset()
    const o = await s.overview()
    expect(o.all.calls).toBe(0)
    expect(o.limits).toHaveLength(1)
  })
})
