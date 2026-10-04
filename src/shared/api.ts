import type { Repo } from '../main/db/repo'

/** The renderer-facing API. Every repo method is reachable as window.asi.api.<group>.<method>(...). */
export type AsiApi = Repo

export const REPO_CHANNEL_PREFIX = 'repo:'

/** Explicit list (contextBridge cannot clone Proxies). test/unit/api.test.ts keeps it in sync with the repo. */
export const REPO_METHODS = {
  workspaces: ['create', 'list', 'get'],
  friends: ['create', 'list', 'get', 'rename', 'setDangerousAllowed', 'remove'],
  labels: ['create', 'list', 'setForFriend', 'setForChat', 'forChat'],
  chats: ['create', 'get', 'list', 'rename', 'setSession', 'setStatus', 'markRead', 'remove'],
  messages: ['append', 'list'],
  attachments: ['add'],
  settings: ['get', 'set'],
  search: ['query']
} as const
