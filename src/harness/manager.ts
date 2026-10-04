import type { AgentEvent, AgentSession, PermDecision, UserTurn } from '@shared/events'
import type { Chat, Friend, HarnessKind, Mode } from '@shared/models'
import type { HarnessFactory } from './types'

export interface ManagerHooks {
  /** Called for every event from any session. */
  onEvent(chatId: string, e: AgentEvent): void
  /** Called when a fresh session reports a resumable id. */
  onResumeId?(chatId: string, id: string): void
}

/** Owns one live AgentSession per chat; sessions start lazily on the first message. */
export class HarnessManager {
  private factories = new Map<HarnessKind, HarnessFactory>()
  private sessions = new Map<string, { session: AgentSession; unsub: () => void }>()
  private starting = new Map<string, Promise<AgentSession>>()

  constructor(private hooks: ManagerHooks) {}

  register(kind: HarnessKind, factory: HarnessFactory): void {
    this.factories.set(kind, factory)
  }

  has(kind: HarnessKind): boolean {
    return this.factories.has(kind)
  }

  isLive(chatId: string): boolean {
    return this.sessions.has(chatId)
  }

  async session(chat: Chat, friend: Friend, cwd: string, mode: Mode = friend.defaultMode): Promise<AgentSession> {
    const live = this.sessions.get(chat.id)
    if (live) return live.session
    const pending = this.starting.get(chat.id)
    if (pending) return pending
    const factory = this.factories.get(friend.harness)
    if (!factory) throw new Error(`no harness registered for "${friend.harness}"`)
    const p = (async () => {
      const session = await factory({ friend, chatId: chat.id, cwd, mode, resumeId: chat.harnessSessionId })
      const unsub = session.subscribe((e) => this.hooks.onEvent(chat.id, e))
      this.sessions.set(chat.id, { session, unsub })
      if (session.resumeId && session.resumeId !== chat.harnessSessionId) this.hooks.onResumeId?.(chat.id, session.resumeId)
      return session
    })()
    this.starting.set(chat.id, p)
    try {
      return await p
    } finally {
      this.starting.delete(chat.id)
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
    this.sessions.get(chatId)?.session.setMode(mode)
  }

  async dispose(chatId: string): Promise<void> {
    const s = this.sessions.get(chatId)
    if (!s) return
    this.sessions.delete(chatId)
    s.unsub()
    await s.session.dispose()
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)))
  }
}
