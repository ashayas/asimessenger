import { EventHub } from './emitter'
import type { AgentEvent, AgentSession, PermDecision, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'

type Step = AgentEvent | { wait: number } | { await: 'answer' }

/** Scripts are chosen from the user's prompt: "/script <name>" (or any prompt -> 'default'). */
const SCRIPTS: Record<string, (args: { prompt: string; id: string }) => Step[]> = {
  default: ({ prompt, id }) => [
    { t: 'status', phase: 'thinking' },
    { wait: 20 },
    { t: 'text', id, delta: `You said: ${prompt}` },
    { t: 'turn_end', reason: 'done' }
  ],
  tools: ({ id }) => [
    { t: 'status', phase: 'tool', detail: 'pnpm vitest run' },
    { t: 'tool', id: `${id}-t1`, kind: 'exec', title: 'Run tests', command: 'pnpm vitest run src/auth/session.test.ts', cwd: '~/code/honeycomb', done: false },
    { wait: 20 },
    { t: 'tool', id: `${id}-t1`, kind: 'exec', title: 'Run tests', command: 'pnpm vitest run src/auth/session.test.ts', cwd: '~/code/honeycomb', output: '✗ refreshes once under concurrent calls\n  1 failed | 23 passed', exit: 1, durationMs: 2400, done: true },
    { t: 'tool', id: `${id}-t2`, kind: 'edit', title: 'Edit files', files: [{ path: 'src/auth/session.ts', added: 14, removed: 6 }], done: true },
    { t: 'text', id, delta: 'Fixed the race in the refresh path.' },
    { t: 'turn_end', reason: 'done' }
  ],
  permission: ({ id }) => [
    { t: 'status', phase: 'waiting', detail: 'rm -rf dist' },
    { t: 'permission', reqId: `${id}-p1`, tool: 'exec', summary: 'rm -rf dist && pnpm build', options: [{ id: 'allow-once', label: 'Allow once' }, { id: 'allow-chat', label: 'Allow for this chat' }, { id: 'deny', label: 'Deny' }] },
    { await: 'answer' },
    { t: 'text', id, delta: 'Permission handled.' },
    { t: 'turn_end', reason: 'done' }
  ],
  question: ({ id }) => [
    { t: 'status', phase: 'waiting', detail: 'question' },
    { t: 'question', reqId: `${id}-q1`, prompt: 'Should the refresh lock be per tab or global?', choices: ['Per tab', 'Global'] },
    { await: 'answer' },
    { t: 'text', id, delta: 'Got it.' },
    { t: 'turn_end', reason: 'done' }
  ],
  attachment: ({ id }) => [
    { t: 'attachment', id: `${id}-a1`, kind: 'markdown', name: 'refresh-race.md', body: '# Root cause\n\nThe refresh runs twice under concurrent calls.\n' },
    { t: 'text', id, delta: 'Wrote up the root cause.' },
    { t: 'turn_end', reason: 'done' }
  ],
  long: ({ id }) => [
    { t: 'status', phase: 'tool', detail: 'sleep 30' },
    { t: 'tool', id: `${id}-t1`, kind: 'exec', title: 'Long task', command: 'sleep 30', done: false },
    { wait: 30_000 },
    { t: 'text', id, delta: 'finished (should have been interrupted)' },
    { t: 'turn_end', reason: 'done' }
  ]
}

/** Deterministic agent for tests and the UI gallery. Interruptible; supports permission/question round trips. */
export class FakeAgent implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly resumeId = `fake-${Math.random().toString(36).slice(2, 8)}`
  mode: Mode = 'ask'
  /** Answers received, for assertions. */
  readonly answers: { reqId: string; answer: string; reason?: string }[] = []
  private runId = 0
  private waiter: ((a: string) => void) | null = null
  private abort: (() => void) | null = null
  private turn = 0

  send(turn: UserTurn): void {
    const m = /^\/script\s+(\w+)/.exec(turn.text)
    const name = m?.[1] ?? 'default'
    const id = `m${++this.turn}`
    const steps = (SCRIPTS[name] ?? SCRIPTS['default']!)({ prompt: turn.text, id })
    void this.run(steps)
  }

  private async run(steps: Step[]): Promise<void> {
    const run = ++this.runId
    let aborted = false
    let wake: (() => void) | null = null
    this.abort = () => { aborted = true; wake?.() }
    const sleep = (ms: number) => new Promise<void>((r) => { wake = r; setTimeout(r, ms) })

    for (const step of steps) {
      if (aborted || run !== this.runId) break
      if ('wait' in step) await sleep(step.wait)
      else if ('await' in step) {
        await new Promise<void>((resolve) => { this.waiter = () => resolve(); wake = resolve })
        this.waiter = null
      } else this.hub.emit(step)
    }
    if (aborted && run === this.runId) {
      this.hub.emit({ t: 'turn_end', reason: 'interrupted' })
    }
  }

  async interrupt(): Promise<void> {
    this.abort?.()
    this.waiter?.('')
  }

  respond(reqId: string, answer: PermDecision | string, reason?: string): void {
    this.answers.push({ reqId, answer, reason })
    this.waiter?.(answer)
  }

  setMode(mode: Mode): void {
    this.mode = mode
  }

  async dispose(): Promise<void> {
    this.abort?.()
    this.hub.closed = true
  }
}
