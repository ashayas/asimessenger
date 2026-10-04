import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { discoverSessions } from '../../src/asi/discovery'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'asi-disc-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

const write = (path: string, lines: unknown[], ageMs: number) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const t = new Date(Date.now() - ageMs)
  utimesSync(path, t, t)
}

test('finds recently active Claude and Codex sessions with their folder and first prompt', async () => {
  write(join(home, '.claude/projects/-tmp-hc/abc-123.jsonl'), [
    { type: 'queue-operation' },
    { type: 'user', cwd: '/tmp/hc', sessionId: 'abc-123', message: { role: 'user', content: 'fix the flaky   refresh test' } }
  ], 60_000)
  write(join(home, '.codex/sessions/2026/10/04/rollout-x-t1.jsonl'), [
    { type: 'session_meta', payload: { id: 't1', cwd: '/tmp/api' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'add pagination to the list endpoint' } }
  ], 120_000)
  const found = await discoverSessions({ home })
  expect(found).toEqual([
    expect.objectContaining({ harness: 'claude', sessionId: 'abc-123', cwd: '/tmp/hc', title: 'fix the flaky refresh test' }),
    expect.objectContaining({ harness: 'codex', sessionId: 't1', cwd: '/tmp/api', title: 'add pagination to the list endpoint' })
  ])
})

test('ignores stale sessions, sub-agent transcripts and files without a folder; handles missing dirs', async () => {
  write(join(home, '.claude/projects/-tmp-old/old.jsonl'), [{ type: 'user', cwd: '/tmp/old', message: { content: 'x' } }], 3 * 3600_000)
  write(join(home, '.claude/projects/-tmp-hc/abc/subagents/agent-1.jsonl'), [{ type: 'user', cwd: '/tmp/hc', message: { content: 'sub' } }], 1000)
  write(join(home, '.claude/projects/-tmp-hc/nocwd.jsonl'), [{ type: 'queue-operation' }], 1000)
  expect(await discoverSessions({ home })).toEqual([])
  expect(await discoverSessions({ home: join(home, 'nothing-here') })).toEqual([])
  expect(await discoverSessions({ home, windowMs: 4 * 3600_000 })).toHaveLength(1) // the window is adjustable
})
