import type { Mode } from './models'
import type { SearchTarget } from './search'

export type Phase = 'idle' | 'thinking' | 'tool' | 'waiting' | 'error' | 'done'
export type ToolKind = 'exec' | 'edit' | 'read' | 'search' | 'web' | 'mcp'
export type Risk = 'low' | 'med' | 'high'
export type PermDecision = 'allow-once' | 'allow-chat' | 'deny'
export type AttachmentKind = 'markdown' | 'code' | 'diff' | 'image' | 'plan'

export interface FileChange {
  path: string
  added: number
  removed: number
}

export interface PermOption {
  id: PermDecision
  label: string
}

/** One normalized stream for every harness. Renderers only know this type. */
export type AgentEvent =
  | { t: 'status'; phase: Phase; detail?: string; kind?: ToolKind }
  | { t: 'text'; id: string; delta: string }
  | { t: 'thinking'; id: string; delta: string }
  | {
      t: 'tool'
      id: string
      kind: ToolKind
      title: string
      command?: string
      cwd?: string
      output?: string
      exit?: number
      durationMs?: number
      files?: FileChange[]
      done?: boolean
    }
  | { t: 'permission'; reqId: string; tool: string; summary: string; risk?: Risk; options: PermOption[] }
  | { t: 'question'; reqId: string; prompt: string; choices?: string[] }
  | { t: 'attachment'; id: string; kind: AttachmentKind; name: string; path?: string; body?: string }
  | { t: 'open_url'; url: string }
  | { t: 'links'; items: { label: string; detail?: string; target: SearchTarget }[] }
  | { t: 'title'; title: string }
  /** Tokens (and cost, when the agent reports one) spent by ONE call or turn. A delta, never a running total: adapters subtract. */
  | { t: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; model?: string }
  /** The agent's own subscription limits for the account, as of now. */
  | { t: 'limits'; provider: 'claude' | 'codex'; plan?: string | null; windows: { id: string; label: string; usedPercent: number; resetsAt: number | null }[]; status?: string | null; note?: string | null }
  | { t: 'turn_end'; reason: 'done' | 'interrupted' | 'error'; error?: string }

export interface UserTurn {
  text: string
  /** Quoted lines the user is replying to (from an attachment), if any. */
  quote?: { name: string; text: string }
  /** Pictures the user attached. Adapters pass them natively when the agent can see images. */
  images?: { path: string; mimeType: string; name: string }[]
}

export interface AgentSession {
  /** Subscribe to events; returns an unsubscribe function. */
  subscribe(listener: (e: AgentEvent) => void): () => void
  send(turn: UserTurn): void
  /** Nudge: stop the current turn. Resolves once the agent has stopped. */
  interrupt(): Promise<void>
  /** Answer a permission request (PermDecision) or a question (free text / chosen option). */
  respond(reqId: string, answer: PermDecision | string, reason?: string): void
  setMode(mode: Mode): void
  /** Opaque id the adapter can resume later (stored on the chat). */
  readonly resumeId?: string
  dispose(): Promise<void>
}
