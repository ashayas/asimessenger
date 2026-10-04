import { basename } from 'node:path'
import type { Repo } from './db/repo'
import { KIND_ORDER, type PaletteResult, type SearchTarget } from '@shared/search'

/** FTS hits resolved to a place you can jump to, grouped in a stable order. */
export async function searchAll(repo: Repo, query: string, limit = 40): Promise<PaletteResult[]> {
  const hits = await repo.search.query(query, { limit })
  const workspaces = new Map((await repo.workspaces.list()).map((w) => [w.id, w]))
  const out: PaletteResult[] = []
  const seenChats = new Set<string>()
  for (const h of hits) {
    let target: SearchTarget | null = null
    if (h.kind === 'chat') target = { type: 'chat', chatId: h.refId, workspaceId: h.workspaceId }
    else if (h.kind === 'friend') target = { type: 'friend', friendId: h.refId }
    else if (h.kind === 'message') {
      const m = await repo.messages.get(h.refId)
      if (m) target = { type: 'chat', chatId: m.chatId, workspaceId: h.workspaceId }
    } else if (h.kind === 'attachment') {
      const a = await repo.attachments.get(h.refId)
      const m = a ? await repo.messages.get(a.messageId) : null
      if (a && m) target = { type: 'attachment', messageId: a.messageId, chatId: m.chatId, workspaceId: h.workspaceId }
    }
    else if (h.kind === 'drawing') {
      const d = await repo.drawings.get(h.refId)
      if (d) target = { type: 'drawing', workspaceId: d.workspaceId, name: basename(d.path).replace(/\.excalidraw$/, '') }
    }
    if (!target) continue
    // a chat that already matched by title should not repeat for each of its messages' titles
    if (h.kind === 'chat') seenChats.add(h.refId)
    const ws = h.workspaceId ? workspaces.get(h.workspaceId) : undefined
    out.push({ kind: h.kind, title: h.title, snippet: h.snippet, workspaceName: ws?.name ?? null, workspaceSlot: ws?.slot ?? null, target })
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}
