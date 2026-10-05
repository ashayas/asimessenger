import type { TitleSource } from './title'
import type { Presence } from './status'

export type HarnessKind = 'claude' | 'codex' | 'pi' | 'acp' | 'pty' | 'http' | 'asi' | 'echo' | 'fake'
export type Mode = 'ask' | 'auto-edit' | 'plan' | 'dangerous'

export interface Workspace {
  id: string
  name: string
  path: string
  slot: number | null
  color: string | null
}

export interface Friend {
  id: string
  harness: HarnessKind
  displayName: string
  avatar: string | null
  command: string | null
  args: string[]
  transport: string | null
  defaultMode: Mode
  dangerousAllowed: boolean
  letteringStyle: string
  secretRef: string | null
  createdAt: number
}

export interface Chat {
  id: string
  workspaceId: string
  friendId: string
  title: string
  titleSource: TitleSource
  /** Set for an isolated chat: the git worktree folder the agent works in, and its branch. */
  worktreePath: string | null
  branch: string | null
  harnessSessionId: string | null
  status: Presence
  statusText: string | null
  mode: Mode
  unreadCount: number
  createdAt: number
  lastActivityAt: number
}

export type MessageRole = 'user' | 'agent' | 'system'

export interface Message {
  id: string
  chatId: string
  role: MessageRole
  kind: string
  body: unknown
  text: string | null
  createdAt: number
  readAt: number | null
}

export interface Label {
  id: string
  name: string
  color: string | null
}

export interface SearchHit {
  kind: 'friend' | 'chat' | 'message' | 'attachment' | 'drawing'
  refId: string
  workspaceId: string | null
  title: string
  snippet: string
}
