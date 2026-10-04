export type SearchTarget =
  | { type: 'chat'; chatId: string; workspaceId: string | null }
  | { type: 'attachment'; messageId: string; chatId: string; workspaceId: string | null }
  | { type: 'friend'; friendId: string }
  | { type: 'drawing'; workspaceId: string; name: string }
  /** An agent session found running outside Messenger: bring it into a chat. */
  | { type: 'adopt'; harness: 'claude' | 'codex'; sessionId: string; cwd: string; title: string }

export interface PaletteResult {
  kind: 'chat' | 'friend' | 'attachment' | 'drawing' | 'message'
  title: string
  snippet: string
  workspaceName: string | null
  workspaceSlot: number | null
  target: SearchTarget
}

export const KIND_ORDER = ['chat', 'friend', 'attachment', 'drawing', 'message'] as const
export const KIND_LABEL: Record<PaletteResult['kind'], string> = {
  chat: 'Chats', friend: 'Friends', attachment: 'Attachments', drawing: 'Drawings', message: 'Messages'
}
