import type { AgentSession } from '@shared/events'
import type { Friend, Mode } from '@shared/models'

export interface SessionContext {
  friend: Friend
  chatId: string
  cwd: string
  mode: Mode
  /** Set when the chat already has an agent session to resume. */
  resumeId?: string | null
}

export type HarnessFactory = (ctx: SessionContext) => Promise<AgentSession>
