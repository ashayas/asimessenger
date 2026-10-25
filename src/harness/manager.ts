import type { AgentEvent, AgentSession, PermDecision, UserTurn } from '@shared/events'
import type { Chat, Friend, HarnessKind, Mode } from '@shared/models'
import type { HarnessFactory, McpEndpoint } from './types'

export interface ParticipantTarget {
  id: string
  agentId: string
  displayName: string
  friendId?: string
  harnessSessionId: string | null
}

export interface ManagerHooks {
  /** Called for every event from any session. */
  onEvent(chatId: string, e: AgentEvent, participant?: ParticipantTarget): void
  /** Called when a fresh session reports a resumable id. */
  onResumeId?(chatId: string, id: string, participant?: ParticipantTarget): void
  /** Where agents in this chat can reach ASI's tools. */
  mcpFor?(chatId: string, participantId?: string): McpEndpoint | undefined
}

/** Owns live AgentSessions per chat (and per participant in multi-agent chats); sessions start lazily on the first message. */
export class HarnessManager {
  private factories = new Map<HarnessKind, HarnessFactory>()
  private sessions = new Map<string, { session: AgentSession; unsub: () => void; mode: Mode; argsKey: string }>()
  /** Session keys whose agent must start over in a new mode once its current turn ends. */
  private restartAfterTurn = new Set<string>()
  private starting = new Map<string, { promise: Promise<AgentSession>; cancelled: boolean; mode: Mode }>()
  private stopping = new Map<string, Promise<void>>()

  constructor(private hooks: ManagerHooks) {}

  private keyFor(chatId: string, participantId?: string): string {
    return participantId ? `${chatId}::${participantId}` : chatId
  }

  private keysForChat(chatId: string): string[] {
    const prefix = `${chatId}::`
    const all = new Set<string>([
      ...this.sessions.keys(),
      ...this.starting.keys(),
      ...this.stopping.keys()
    ])
    return [...all].filter((k) => k === chatId || k.startsWith(prefix))
  }

  register(kind: HarnessKind, factory: HarnessFactory): void {
    this.factories.set(kind, factory)
  }

  has(kind: HarnessKind): boolean {
    return this.factories.has(kind)
  }

  /** The live session for a chat, if any (used for the terminal drawer). */
  live(chatId: string, participantId?: string): AgentSession | undefined {
    if (participantId) return this.sessions.get(this.keyFor(chatId, participantId))?.session
    const direct = this.sessions.get(chatId)?.session
    if (direct) return direct
    for (const k of this.keysForChat(chatId)) {
      const s = this.sessions.get(k)?.session
      if (s) return s
    }
    return undefined
  }

  isLive(chatId: string, participantId?: string): boolean {
    if (participantId) return this.sessions.has(this.keyFor(chatId, participantId))
    return this.keysForChat(chatId).some((k) => this.sessions.has(k))
  }

  async session(chat: Chat, friend: Friend, cwd: string, mode: Mode = friend.defaultMode, participant?: ParticipantTarget): Promise<AgentSession> {
    const key = this.keyFor(chat.id, participant?.id)
    await this.stopping.get(key)
    const argsKey = JSON.stringify(friend.args ?? [])
    const live = this.sessions.get(key)
    if (live && !live.session.closed && (live.argsKey === argsKey || live.session.busy)) return live.session
    if (live) await this.disposeKey(key)
    const pending = this.starting.get(key)
    if (pending) return pending.promise
    const factory = this.factories.get(friend.harness)
    if (!factory) throw new Error(`no harness registered for "${friend.harness}"`)
    const resumeId = participant ? participant.harnessSessionId : chat.harnessSessionId
    const start = { promise: null as unknown as Promise<AgentSession>, cancelled: false, mode }
    const p = (async () => {
      const session = await factory({ friend, chatId: chat.id, cwd, mode, resumeId, mcp: this.hooks.mcpFor?.(chat.id, participant?.id) })
      if (start.cancelled) { await session.dispose(); throw new Error('session startup was cancelled') }
      const unsub = session.subscribe((e) => {
        this.hooks.onEvent(chat.id, e, participant)
        if (e.t === 'turn_end' && this.restartAfterTurn.delete(key)) void this.disposeKey(key) // the next message starts a fresh session in the new mode
      })
      this.sessions.set(key, { session, unsub, mode, argsKey })
      if (session.resumeId && session.resumeId !== resumeId) this.hooks.onResumeId?.(chat.id, session.resumeId, participant)
      return session
    })()
    start.promise = p
    this.starting.set(key, start)
    try {
      return await p
    } finally {
      if (this.starting.get(key) === start) this.starting.delete(key)
    }
  }

  async send(chat: Chat, friend: Friend, cwd: string, turn: UserTurn, participant?: ParticipantTarget): Promise<void> {
    const s = await this.session(chat, friend, cwd, chat.mode, participant)
    s.send(turn)
  }

  async interrupt(chatId: string, participantId?: string): Promise<void> {
    if (participantId) {
      await this.sessions.get(this.keyFor(chatId, participantId))?.session.interrupt()
      return
    }
    await Promise.all(
      this.keysForChat(chatId).map((k) => this.sessions.get(k)?.session.interrupt() ?? Promise.resolve())
    )
  }

  respond(chatId: string, reqId: string, answer: PermDecision | string, reason?: string, participantId?: string): void {
    if (participantId) {
      const target = this.sessions.get(this.keyFor(chatId, participantId))
      if (target) {
        target.session.respond(reqId, answer, reason)
        return
      }
    }
    for (const k of this.keysForChat(chatId)) {
      this.sessions.get(k)?.session.respond(reqId, answer, reason)
    }
  }

  setMode(chatId: string, mode: Mode): void {
    const keys = this.keysForChat(chatId)
    for (const key of keys) {
      const s = this.sessions.get(key)
      if (!s) {
        const pending = this.starting.get(key)
        if (pending && pending.mode !== mode) void this.disposeKey(key)
        continue
      }
      s.session.setMode(mode)
      // some agents only read their permission policy at launch: a new mode means a new process, never a silent no-op
      if (s.session.restartOnModeChange && s.mode !== mode) {
        if (s.session.busy) this.restartAfterTurn.add(key)
        else void this.disposeKey(key)
      } else {
        this.restartAfterTurn.delete(key)
        s.mode = mode
      }
    }
  }

  private disposeKey(key: string): Promise<void> {
    const stopping = this.stopping.get(key)
    if (stopping) return stopping
    const pending = this.starting.get(key)
    if (pending) pending.cancelled = true
    const s = this.sessions.get(key)
    this.sessions.delete(key)
    this.restartAfterTurn.delete(key)
    s?.unsub()
    const stopped = (async () => {
      if (pending) await pending.promise.catch(() => {})
      await s?.session.dispose()
    })()
    this.stopping.set(key, stopped)
    void stopped.finally(() => { if (this.stopping.get(key) === stopped) this.stopping.delete(key) }).catch(() => {})
    return stopped
  }

  async dispose(chatId: string, participantId?: string): Promise<void> {
    if (participantId) {
      await this.disposeKey(this.keyFor(chatId, participantId))
      return
    }
    const keys = this.keysForChat(chatId)
    await Promise.all(keys.map((k) => this.disposeKey(k)))
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...new Set([...this.sessions.keys(), ...this.starting.keys(), ...this.stopping.keys()])].map((key) => this.disposeKey(key)))
  }
}
