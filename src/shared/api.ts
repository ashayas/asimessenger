import type { Repo } from '../main/db/repo'

/** The renderer-facing API. Every repo method is reachable as window.asi.api.<group>.<method>(...). */
export type AsiApi = Repo

export const REPO_CHANNEL_PREFIX = 'repo:'
export const CHANGED_CHANNEL = 'asi:changed'

/** Explicit list (contextBridge cannot clone Proxies). test/unit/api.test.ts keeps it in sync with the repo. */
export const REPO_METHODS = {
  workspaces: ['create', 'list', 'get', 'rename', 'remove'],
  friends: ['create', 'list', 'get', 'rename', 'setDangerousAllowed', 'remove'],
  labels: ['create', 'list', 'setForFriend', 'setForChat', 'forFriend', 'forChat', 'assignments', 'rename', 'remove'],
  chats: ['create', 'get', 'list', 'rename', 'setMode', 'setSession', 'setStatus', 'markRead', 'remove'],
  messages: ['append', 'update', 'get', 'list'],
  attachments: ['get', 'add'],
  settings: ['get', 'set'],
  search: ['query']
} as const
