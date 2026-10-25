import type { AgentEvent, AgentSession, PermDecision, UserTurn } from '@shared/events'
import type { Chat, Friend, HarnessKind, Mode } from '@shared/models'
import type { HarnessFactory, McpEndpoint } from './types'

export interface ManagerHooks {
  /** Called for every event from any session. */
  onEvent(chatId: string, e: AgentEvent): void
  /** Called when a fresh session reports a resumable id. */
  onResumeId?(chatId: string, id: string): void
  /** Where agents in this chat can reach ASI's tools. */
  mcpFor?(chatId: string): McpEndpoint | undefined
}

/** Owns one live AgentSession per chat; sessions start lazily on the first message. */
export class HarnessManager {
  private factories = new Map<HarnessKind, HarnessFactory>()
  private sessions = new Map<string, { session: AgentSession; unsub: () => void; mode: Mode; argsKey: string }>()
  /** Chats whose agent must start over in a new mode once its current turn ends. */
  private restartAfterTurn = new Set<string>()
  private starting = new Map<string, { promise: Promise<AgentSession>; cancelled: boolean; mode: Mode }>()
  private stopping = new Map<string, Promise<void>>()

  constructor(private hooks: ManagerHooks) {}

  register(kind: HarnessKind, factory: HarnessFactory): void {
    this.factories.set(kind, factory)
  }

  has(kind: HarnessKind): boolean {
    return this.factories.has(kind)
  }

  /** The live session for a chat, if any (used for the terminal drawer). */
  live(chatId: string): AgentSession | undefined {
    return this.sessions.get(chatId)?.session
  }

  isLive(chatId: string): boolean {
    return this.sessions.has(chatId)
  }

  async session(chat: Chat, friend: Friend, cwd: string, mode: Mode = friend.defaultMode): Promise<AgentSession> {
    await this.stopping.get(chat.id)
    const argsKey = JSON.stringify(friend.args ?? [])
    const live = this.sessions.get(chat.id)
    if (live && !live.session.closed && (live.argsKey === argsKey || live.session.busy)) return live.session
    if (live) await this.dispose(chat.id)
    const pending = this.starting.get(chat.id)
    if (pending) return pending.promise
    const factory = this.factories.get(friend.harness)
    if (!factory) throw new Error(`no harness registered for "${friend.harness}"`)
    const start = { promise: null as unknown as Promise<AgentSession>, cancelled: false, mode }
    const p = (async () => {
      const session = await factory({ friend, chatId: chat.id, cwd, mode, resumeId: chat.harnessSessionId, mcp: this.hooks.mcpFor?.(chat.id) })
      if (start.cancelled) { await session.dispose(); throw new Error('session startup was cancelled') }
      const unsub = session.subscribe((e) => {
        this.hooks.onEvent(chat.id, e)
        if (e.t === 'turn_end' && this.restartAfterTurn.delete(chat.id)) void this.dispose(chat.id) // the next message starts a fresh session in the new mode
      })
      this.sessions.set(chat.id, { session, unsub, mode, argsKey })
      if (session.resumeId && session.resumeId !== chat.harnessSessionId) this.hooks.onResumeId?.(chat.id, session.resumeId)
      return session
    })()
    start.promise = p
    this.starting.set(chat.id, start)
    try {
      return await p
    } finally {
      if (this.starting.get(chat.id) === start) this.starting.delete(chat.id)
    }
  }

  async send(chat: Chat, friend: Friend, cwd: string, turn: UserTurn): Promise<void> {
    const s = await this.session(chat, friend, cwd, chat.mode)
    s.send(turn)
  }

  async interrupt(chatId: string): Promise<void> {
    await this.sessions.get(chatId)?.session.interrupt()
  }

  respond(chatId: string, reqId: string, answer: PermDecision | string, reason?: string): void {
    this.sessions.get(chatId)?.session.respond(reqId, answer, reason)
  }

  setMode(chatId: string, mode: Mode): void {
    const s = this.sessions.get(chatId)
    if (!s) {
      const pending = this.starting.get(chatId)
      if (pending && pending.mode !== mode) void this.dispose(chatId)
      return
    }
    s.session.setMode(mode)
    // some agents only read their permission policy at launch: a new mode means a new process, never a silent no-op
    if (s.session.restartOnModeChange && s.mode !== mode) {
      if (s.session.busy) this.restartAfterTurn.add(chatId)
      else void this.dispose(chatId)
    } else {
      this.restartAfterTurn.delete(chatId)
      s.mode = mode
    }
  }

  dispose(chatId: string): Promise<void> {
    const stopping = this.stopping.get(chatId)
    if (stopping) return stopping
    const pending = this.starting.get(chatId)
    if (pending) pending.cancelled = true
    const s = this.sessions.get(chatId)
    this.sessions.delete(chatId)
    this.restartAfterTurn.delete(chatId)
    s?.unsub()
    const stopped = (async () => {
      if (pending) await pending.promise.catch(() => {})
      await s?.session.dispose()
    })()
    this.stopping.set(chatId, stopped)
    void stopped.finally(() => { if (this.stopping.get(chatId) === stopped) this.stopping.delete(chatId) }).catch(() => {})
    return stopped
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...new Set([...this.sessions.keys(), ...this.starting.keys(), ...this.stopping.keys()])].map((id) => this.dispose(id)))
  }
}
