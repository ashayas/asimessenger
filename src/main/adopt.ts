import { basename } from 'node:path'
import type { Repo } from './db/repo'
import type { SearchTarget } from '@shared/search'

/** Bring an agent session found outside Messenger into a chat, so the next message resumes it. Returns the chat id. */
export async function adoptSession(repo: Repo, t: Extract<SearchTarget, { type: 'adopt' }>): Promise<string> {
  const existing = (await repo.chats.list()).find((c) => c.harnessSessionId === t.sessionId)
  if (existing) return existing.id
  const friend = (await repo.friends.list()).find((f) => f.harness === t.harness)
  if (!friend) throw new Error(`add ${t.harness === 'claude' ? 'Claude Code' : 'Codex'} as a friend first (Add a friend), then bring this session in`)
  const workspaces = await repo.workspaces.list()
  let ws = workspaces.filter((w) => t.cwd === w.path || t.cwd.startsWith(w.path.replace(/\/$/, '') + '/')).sort((a, b) => b.path.length - a.path.length)[0]
  if (!ws) ws = await repo.workspaces.create({ name: basename(t.cwd) || 'Workspace', path: t.cwd })
  const chat = await repo.chats.create({ workspaceId: ws.id, friendId: friend.id, title: t.title })
  await repo.chats.setSession(chat.id, t.sessionId)
  return chat.id
}
