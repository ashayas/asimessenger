import type { AgentSession } from '@shared/events'
import type { Friend, Mode } from '@shared/models'

export interface McpEndpoint {
  url: string
  token: string
}

export interface SessionContext {
  friend: Friend
  chatId: string
  cwd: string
  mode: Mode
  /** Set when the chat already has an agent session to resume. */
  resumeId?: string | null
  /** ASI's own MCP server for this chat (ask_user, send_attachment, ...). Injected into every structured harness. */
  mcp?: McpEndpoint
}

export type HarnessFactory = (ctx: SessionContext) => Promise<AgentSession>
