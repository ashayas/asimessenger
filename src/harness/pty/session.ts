import * as pty from '@lydell/node-pty'
import { EventHub } from '../emitter'
import { stripAnsi } from './ansi'
import type { AgentSession, UserTurn } from '@shared/events'

const SCROLLBACK_MAX = 200_000

export interface PtyOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  /** A burst of output ends (and the "turn" completes) after this much silence. */
  idleMs?: number
}

/**
 * Any CLI in a real pseudo-terminal. The terminal drawer shows it live; the transcript gets plain-text bursts.
 * There is no structure to read, so a turn is "you typed something, output flowed, then it went quiet".
 */
export class PtySession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly resumeId = undefined
  private term: pty.IPty
  private scrollback = ''
  private rawListeners = new Set<(d: string) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private turn = 0
  private burst = 0
  private active = false
  private exited = false
  private readonly idleMs: number

  constructor(o: PtyOptions) {
    this.idleMs = o.idleMs ?? 1200
    this.term = pty.spawn(o.command, o.args, {
      name: 'xterm-256color', cols: o.cols ?? 100, rows: o.rows ?? 30, cwd: o.cwd,
      env: { ...o.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    })
    this.term.onData((d) => this.onData(d))
    this.term.onExit(({ exitCode, signal }) => {
      this.exited = true
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.hub.emit({ t: 'turn_end', reason: 'error', error: `process exited (${signal ? `signal ${signal}` : `code ${exitCode}`})` })
    })
  }

  /** Raw bytes for the terminal drawer. Returns an unsubscribe function. */
  onRaw(l: (d: string) => void): () => void {
    this.rawListeners.add(l)
    return () => this.rawListeners.delete(l)
  }

  get buffer(): string { return this.scrollback }
  get isExited(): boolean { return this.exited }

  write(data: string): void { if (!this.exited) this.term.write(data) }
  resize(cols: number, rows: number): void { if (!this.exited && cols > 0 && rows > 0) this.term.resize(cols, rows) }

  private onData(d: string): void {
    this.scrollback = (this.scrollback + d).slice(-SCROLLBACK_MAX)
    for (const l of this.rawListeners) l(d)
    if (!this.active) return
    const text = stripAnsi(d)
    if (text.trim()) this.hub.emit({ t: 'text', id: `pty-${this.turn}-${this.burst}`, delta: text })
    this.hub.emit({ t: 'status', phase: 'tool', kind: 'exec' })
    this.armIdle()
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.finish('done'), this.idleMs)
  }

  private finish(reason: 'done' | 'interrupted'): void {
    if (!this.active) return
    this.active = false
    this.burst++
    this.hub.emit({ t: 'turn_end', reason })
  }

  send(turn: UserTurn): void {
    this.turn++
    this.burst = 0
    this.active = true
    this.hub.emit({ t: 'status', phase: 'thinking' })
    this.term.write(turn.text.replace(/\n/g, '\r') + '\r')
    this.armIdle()
  }

  async interrupt(): Promise<void> {
    if (this.exited) return
    this.term.write('\x03')
    await new Promise((r) => setTimeout(r, 150))
    this.finish('interrupted')
  }

  respond(): void {}
  setMode(): void {}

  async dispose(): Promise<void> {
    this.hub.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.exited) this.term.kill()
  }
}
