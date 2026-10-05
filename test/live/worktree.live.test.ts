import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { claudeFactory } from '../../src/harness/claude/factory'
import { loginEnv, which } from '../../src/harness/env'
import { createWorktrees } from '../../src/main/worktrees'
import type { AgentSession } from '../../src/shared/events'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

// Two real Claude Code sessions write the SAME file name in the SAME repo at the same time, each in its own worktree.
const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
let base: string
beforeAll(() => { ws = makeTestWorkspace(); base = realpathSync(mkdtempSync(join(tmpdir(), 'asi-live-wt-'))) })
afterAll(() => { ws?.cleanup(); rmSync(base, { recursive: true, force: true }) })

describe.skipIf(!live)('parallel agents in isolated worktrees', async () => {
  const env = await loginEnv()
  test.skipIf(!which('claude', env))('two Claudes, one repo, one file name, no collision', async () => {
    const wt = createWorktrees({ dir: join(base, 'worktrees') })
    const [a, b] = [await wt.create(ws.dir), await wt.create(ws.dir)]
    const run = async (w: { path: string }, word: string): Promise<AgentSession> => {
      const s = await claudeFactory({ friend: friendFor({ harness: 'claude', args: ['--model', 'haiku'] }) as never, chatId: word, cwd: w.path, mode: 'ask' })
      const c = collect(s)
      s.send({ text: `Create a file named same.txt in the current directory containing exactly the word ${word}. Use your file write tool, then reply done.` })
      for (let i = 0; i < 120 && !c.events.some((e) => e.t === 'turn_end'); i++) {
        for (const e of c.events) if (e.t === 'permission' && !(e as { seen?: boolean }).seen) { (e as { seen?: boolean }).seen = true; s.respond(e.reqId, 'allow-once') }
        await new Promise((r) => setTimeout(r, 500))
      }
      await c.until((e) => e.t === 'turn_end', 60_000)
      return s
    }
    const sessions = await Promise.all([run(a, 'alpha'), run(b, 'bravo')])
    for (const s of sessions) await s.dispose()
    expect(readFileSync(join(a.path, 'same.txt'), 'utf8').trim()).toBe('alpha')
    expect(readFileSync(join(b.path, 'same.txt'), 'utf8').trim()).toBe('bravo')
    expect(existsSync(join(ws.dir, 'same.txt'))).toBe(false) // the real checkout never saw either
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: ws.dir, encoding: 'utf8' }).trim()).toBe('')
  }, 240_000)
})
