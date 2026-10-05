import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { canReplaceTitle, type TitleSource } from '@shared/title'
import type { UsageGroup, UsageTotals } from '@shared/usage'
import type { Chat, Friend, HarnessKind, Label, Message, MessageRole, Mode, SearchHit, Workspace } from '@shared/models'
import type { Presence } from '@shared/status'

type Row = Record<string, unknown>
const now = () => Date.now()

const toWorkspace = (r: Row): Workspace => ({
  id: String(r['id']), name: String(r['name']), path: String(r['path']),
  slot: r['slot'] == null ? null : Number(r['slot']), color: (r['color'] as string | null) ?? null
})
const toFriend = (r: Row): Friend => ({
  id: String(r['id']), harness: r['harness'] as HarnessKind, displayName: String(r['display_name']),
  avatar: (r['avatar'] as string | null) ?? null, command: (r['command'] as string | null) ?? null,
  args: JSON.parse(String(r['args_json'])), transport: (r['transport'] as string | null) ?? null,
  defaultMode: r['default_mode'] as Mode, dangerousAllowed: Number(r['dangerous_allowed']) === 1,
  letteringStyle: String(r['lettering_style']), secretRef: (r['secret_ref'] as string | null) ?? null,
  createdAt: Number(r['created_at'])
})
const toChat = (r: Row): Chat => ({
  id: String(r['id']), workspaceId: String(r['workspace_id']), friendId: String(r['friend_id']),
  title: String(r['title']), titleSource: ((r['title_source'] as string | null) ?? 'user') as TitleSource, worktreePath: (r['worktree_path'] as string | null) ?? null, branch: (r['branch'] as string | null) ?? null, harnessSessionId: (r['harness_session_id'] as string | null) ?? null,
  status: r['status'] as Presence, statusText: (r['status_text'] as string | null) ?? null, mode: (r['mode'] as Mode) ?? 'ask', unreadCount: Number(r['unread_count']),
  createdAt: Number(r['created_at']), lastActivityAt: Number(r['last_activity_at'])
})
const toMessage = (r: Row): Message => ({
  id: String(r['id']), chatId: String(r['chat_id']), role: r['role'] as MessageRole, kind: String(r['kind']),
  body: JSON.parse(String(r['body_json'])), text: (r['text'] as string | null) ?? null,
  createdAt: Number(r['created_at']), readAt: r['read_at'] == null ? null : Number(r['read_at'])
})

export function createRepo(db: Db) {
  const all = async (sql: string, args: (string | number | null)[] = []) => (await db.execute({ sql, args })).rows as unknown as Row[]
  const run = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args })

  return {
    workspaces: {
      /** slot: omit to take the next free ⌘1-9 slot; pass null for no shortcut. */
      async create(w: { name: string; path: string; slot?: number | null; color?: string | null }): Promise<Workspace> {
        const id = randomUUID()
        let slot = w.slot
        if (slot === undefined) {
          const used = new Set((await all('SELECT slot FROM workspaces WHERE slot IS NOT NULL')).map((r) => Number(r['slot'])))
          slot = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !used.has(n)) ?? null
        }
        await run('INSERT INTO workspaces(id,name,path,slot,color) VALUES (?,?,?,?,?)', [id, w.name, w.path, slot, w.color ?? null])
        return { id, name: w.name, path: w.path, slot, color: w.color ?? null }
      },
      async rename(id: string, name: string): Promise<void> {
        await run('UPDATE workspaces SET name = ? WHERE id = ?', [name, id])
      },
      async setPath(id: string, path: string): Promise<void> {
        await run('UPDATE workspaces SET path = ? WHERE id = ?', [path, id])
      },
      async remove(id: string): Promise<void> {
        await run('DELETE FROM workspaces WHERE id = ?', [id])
      },
      async list(): Promise<Workspace[]> {
        return (await all('SELECT * FROM workspaces ORDER BY COALESCE(slot, 999), name')).map(toWorkspace)
      },
      async get(id: string): Promise<Workspace | null> {
        const r = (await all('SELECT * FROM workspaces WHERE id = ?', [id]))[0]
        return r ? toWorkspace(r) : null
      }
    },

    friends: {
      async create(f: Partial<Friend> & { harness: HarnessKind; displayName: string }): Promise<Friend> {
        const id = randomUUID()
        await run(
          `INSERT INTO friends(id,harness,display_name,avatar,command,args_json,transport,default_mode,dangerous_allowed,lettering_style,secret_ref,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, f.harness, f.displayName, f.avatar ?? null, f.command ?? null, JSON.stringify(f.args ?? []), f.transport ?? null,
           f.defaultMode ?? 'ask', f.dangerousAllowed ? 1 : 0, f.letteringStyle ?? 'funky', f.secretRef ?? null, now()]
        )
        return (await this.get(id))!
      },
      async list(): Promise<Friend[]> {
        return (await all('SELECT * FROM friends ORDER BY created_at')).map(toFriend)
      },
      async get(id: string): Promise<Friend | null> {
        const r = (await all('SELECT * FROM friends WHERE id = ?', [id]))[0]
        return r ? toFriend(r) : null
      },
      async rename(id: string, displayName: string): Promise<void> {
        await run('UPDATE friends SET display_name = ? WHERE id = ?', [displayName, id])
      },
      async setLettering(id: string, style: 'funky' | 'plain'): Promise<void> {
        await run('UPDATE friends SET lettering_style = ? WHERE id = ?', [style, id])
      },
      async setDangerousAllowed(id: string, allowed: boolean): Promise<void> {
        await run('UPDATE friends SET dangerous_allowed = ? WHERE id = ?', [allowed ? 1 : 0, id])
      },
      async remove(id: string): Promise<void> {
        await run('DELETE FROM friends WHERE id = ?', [id])
      }
    },

    labels: {
      async create(name: string, color: string | null = null): Promise<Label> {
        const id = randomUUID()
        await run('INSERT INTO labels(id,name,color) VALUES (?,?,?)', [id, name, color])
        return { id, name, color }
      },
      async list(): Promise<Label[]> {
        return (await all('SELECT * FROM labels ORDER BY name')).map((r) => ({ id: String(r['id']), name: String(r['name']), color: (r['color'] as string | null) ?? null }))
      },
      async setForFriend(friendId: string, labelIds: string[]): Promise<void> {
        await run('DELETE FROM friend_labels WHERE friend_id = ?', [friendId])
        for (const l of labelIds) await run('INSERT INTO friend_labels(friend_id,label_id) VALUES (?,?)', [friendId, l])
      },
      async setForChat(chatId: string, labelIds: string[]): Promise<void> {
        await run('DELETE FROM chat_labels WHERE chat_id = ?', [chatId])
        for (const l of labelIds) await run('INSERT INTO chat_labels(chat_id,label_id) VALUES (?,?)', [chatId, l])
      },
      async forFriend(friendId: string): Promise<Label[]> {
        return (await all('SELECT l.* FROM labels l JOIN friend_labels fl ON fl.label_id = l.id WHERE fl.friend_id = ? ORDER BY l.name', [friendId]))
          .map((r) => ({ id: String(r['id']), name: String(r['name']), color: (r['color'] as string | null) ?? null }))
      },
      /** Every (target, label) pair, for building the Labels view in one round trip. */
      async assignments(): Promise<{ friends: { friendId: string; labelId: string }[]; chats: { chatId: string; labelId: string }[] }> {
        const f = await all('SELECT friend_id, label_id FROM friend_labels')
        const c = await all('SELECT chat_id, label_id FROM chat_labels')
        return {
          friends: f.map((r) => ({ friendId: String(r['friend_id']), labelId: String(r['label_id']) })),
          chats: c.map((r) => ({ chatId: String(r['chat_id']), labelId: String(r['label_id']) }))
        }
      },
      async rename(id: string, name: string): Promise<void> {
        await run('UPDATE labels SET name = ? WHERE id = ?', [name, id])
      },
      async remove(id: string): Promise<void> {
        await run('DELETE FROM labels WHERE id = ?', [id])
      },
      async forChat(chatId: string): Promise<Label[]> {
        return (await all('SELECT l.* FROM labels l JOIN chat_labels cl ON cl.label_id = l.id WHERE cl.chat_id = ? ORDER BY l.name', [chatId]))
          .map((r) => ({ id: String(r['id']), name: String(r['name']), color: (r['color'] as string | null) ?? null }))
      }
    },

    chats: {
      async create(c: { workspaceId: string; friendId: string; title?: string; mode?: Mode; worktree?: { path: string; branch: string } }): Promise<Chat> {
        const id = randomUUID()
        const t = now()
        const mode = c.mode ?? (await all('SELECT default_mode FROM friends WHERE id = ?', [c.friendId]))[0]?.['default_mode'] ?? 'ask'
        await run(
          'INSERT INTO chats(id,workspace_id,friend_id,title,title_source,mode,worktree_path,branch,created_at,last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [id, c.workspaceId, c.friendId, c.title ?? 'New chat', c.title ? 'user' : 'default', mode as string, c.worktree?.path ?? null, c.worktree?.branch ?? null, t, t]
        )
        return (await this.get(id))!
      },
      async get(id: string): Promise<Chat | null> {
        const r = (await all('SELECT * FROM chats WHERE id = ?', [id]))[0]
        return r ? toChat(r) : null
      },
      async list(opts: { workspaceId?: string; friendId?: string } = {}): Promise<Chat[]> {
        const where: string[] = []
        const args: string[] = []
        if (opts.workspaceId) { where.push('workspace_id = ?'); args.push(opts.workspaceId) }
        if (opts.friendId) { where.push('friend_id = ?'); args.push(opts.friendId) }
        const sql = `SELECT * FROM chats ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_activity_at DESC`
        return (await all(sql, args)).map(toChat)
      },
      /** You renamed it: from now on no automatic title replaces it. */
      async rename(id: string, title: string): Promise<void> {
        await run("UPDATE chats SET title = ?, title_source = 'user' WHERE id = ?", [title, id])
      },
      /** An automatic title (first-message rule, the agent's own, or a model's). Ignored when it may not replace the current one. */
      async setAutoTitle(id: string, title: string, source: TitleSource): Promise<boolean> {
        const cur = (await all('SELECT title_source FROM chats WHERE id = ?', [id]))[0]
        if (!cur || !title.trim() || !canReplaceTitle(String(cur['title_source']) as TitleSource, source)) return false
        await run('UPDATE chats SET title = ?, title_source = ? WHERE id = ?', [title.trim(), source, id])
        return true
      },
      async setMode(id: string, mode: Mode): Promise<void> {
        await run('UPDATE chats SET mode = ? WHERE id = ?', [mode, id])
      },
      async setSession(id: string, sessionId: string | null): Promise<void> {
        await run('UPDATE chats SET harness_session_id = ? WHERE id = ?', [sessionId, id])
      },
      async setStatus(id: string, status: Presence, statusText: string | null = null): Promise<void> {
        await run('UPDATE chats SET status = ?, status_text = ?, last_activity_at = ? WHERE id = ?', [status, statusText, now(), id])
      },
      async markRead(id: string): Promise<void> {
        await run('UPDATE chats SET unread_count = 0 WHERE id = ?', [id])
        await run('UPDATE messages SET read_at = ? WHERE chat_id = ? AND read_at IS NULL', [now(), id])
      },
      async remove(id: string): Promise<void> {
        await run('DELETE FROM chats WHERE id = ?', [id])
      }
    },

    messages: {
      async append(m: { chatId: string; role: MessageRole; kind: string; body: unknown; text?: string | null }): Promise<Message> {
        const id = randomUUID()
        const t = now()
        const unread = m.role === 'agent'
        await run(
          'INSERT INTO messages(id,chat_id,role,kind,body_json,text,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)',
          [id, m.chatId, m.role, m.kind, JSON.stringify(m.body ?? null), m.text ?? null, t, unread ? null : t]
        )
        await run(
          `UPDATE chats SET last_activity_at = ?, unread_count = unread_count + ? WHERE id = ?`,
          [t, unread ? 1 : 0, m.chatId]
        )
        return (await toMessageById(id))!
      },
      async update(id: string, patch: { body?: unknown; text?: string | null }): Promise<void> {
        if (patch.body !== undefined) await run('UPDATE messages SET body_json = ? WHERE id = ?', [JSON.stringify(patch.body), id])
        if (patch.text !== undefined) await run('UPDATE messages SET text = ? WHERE id = ?', [patch.text, id])
      },
      async get(id: string): Promise<Message | null> {
        return toMessageById(id)
      },
      async list(chatId: string, opts: { limit?: number } = {}): Promise<Message[]> {
        const rows = await all('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid', [chatId])
        const msgs = rows.map(toMessage)
        return opts.limit ? msgs.slice(-opts.limit) : msgs
      }
    },

    attachments: {
      async get(id: string): Promise<{ id: string; messageId: string; kind: string; name: string } | null> {
        const r = (await all('SELECT id, message_id, kind, name FROM attachments WHERE id = ?', [id]))[0]
        return r ? { id: String(r['id']), messageId: String(r['message_id']), kind: String(r['kind']), name: String(r['name']) } : null
      },
      async add(a: { messageId: string; kind: string; name: string; path?: string | null; body?: string | null }): Promise<string> {
        const id = randomUUID()
        await run('INSERT INTO attachments(id,message_id,kind,name,path,body) VALUES (?,?,?,?,?,?)', [id, a.messageId, a.kind, a.name, a.path ?? null, a.body ?? null])
        return id
      }
    },

    drawings: {
      /** Register (or touch) a drawing file so it is searchable. */
      async upsert(d: { workspaceId: string; path: string; title: string }): Promise<string> {
        const existing = (await all('SELECT id FROM drawings WHERE path = ?', [d.path]))[0]
        if (existing) {
          await run('UPDATE drawings SET updated_at = ? WHERE id = ?', [now(), String(existing['id'])])
          return String(existing['id'])
        }
        const id = randomUUID()
        await run('INSERT INTO drawings(id,workspace_id,path,title,updated_at) VALUES (?,?,?,?,?)', [id, d.workspaceId, d.path, d.title, now()])
        return id
      },
      async get(id: string): Promise<{ id: string; workspaceId: string; path: string; title: string } | null> {
        const r = (await all('SELECT * FROM drawings WHERE id = ?', [id]))[0]
        return r ? { id: String(r['id']), workspaceId: String(r['workspace_id']), path: String(r['path']), title: String(r['title']) } : null
      },
      async list(workspaceId: string): Promise<{ id: string; path: string; title: string; updatedAt: number }[]> {
        return (await all('SELECT * FROM drawings WHERE workspace_id = ? ORDER BY updated_at DESC', [workspaceId])).map((r) => ({ id: String(r['id']), path: String(r['path']), title: String(r['title']), updatedAt: Number(r['updated_at']) }))
      }
    },

    data: {
      /** Everything you typed and everything agents answered, as plain JSON you own. */
      async exportAll(): Promise<{ exportedAt: string; workspaces: unknown[]; friends: unknown[]; chats: unknown[] }> {
        const friends = (await all('SELECT id, harness, display_name, command FROM friends')).map((f) => ({ id: f['id'], harness: f['harness'], name: f['display_name'], command: f['command'] }))
        const workspaces = (await all('SELECT id, name, path FROM workspaces')).map((w) => ({ id: w['id'], name: w['name'], path: w['path'] }))
        const chats = []
        for (const c of await all('SELECT * FROM chats ORDER BY created_at')) {
          const msgs = await all('SELECT role, kind, text, body_json, created_at FROM messages WHERE chat_id = ? ORDER BY created_at, rowid', [String(c['id'])])
          chats.push({ id: c['id'], title: c['title'], workspaceId: c['workspace_id'], friendId: c['friend_id'], createdAt: c['created_at'], messages: msgs.map((m) => ({ role: m['role'], kind: m['kind'], text: m['text'], at: m['created_at'], body: JSON.parse(String(m['body_json'])) })) })
        }
        return { exportedAt: new Date().toISOString(), workspaces, friends, chats }
      },
      /** Deletes all chats (and their messages, attachments, permission records). Friends, workspaces and settings stay. */
      async deleteAllChats(): Promise<number> {
        const n = Number((await all('SELECT COUNT(*) AS c FROM chats'))[0]?.['c'] ?? 0)
        await run('DELETE FROM chats')
        return n
      }
    },

    usage: {
      /** Record what one call or turn spent. Names are copied in, so the numbers still read right after a chat or friend is deleted. */
      async record(e: { chatId: string | null; chatTitle?: string | null; friendId?: string | null; friendName?: string | null; workspaceId?: string | null; workspaceName?: string | null; harness?: string | null; model?: string | null; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number | null; ts?: number }): Promise<void> {
        await run(
          'INSERT INTO usage_log(ts,chat_id,chat_title,friend_id,friend_name,workspace_id,workspace_name,harness,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [e.ts ?? now(), e.chatId, e.chatTitle ?? null, e.friendId ?? null, e.friendName ?? null, e.workspaceId ?? null, e.workspaceName ?? null, e.harness ?? null, e.model ?? null, Math.max(0, Math.round(e.inputTokens)), Math.max(0, Math.round(e.outputTokens)), Math.max(0, Math.round(e.cacheReadTokens ?? 0)), Math.max(0, Math.round(e.cacheWriteTokens ?? 0)), e.costUsd ?? null]
        )
      },
      /** Totals since a time (ms), optionally for one chat. */
      async totals(sinceMs = 0, chatId?: string): Promise<UsageTotals> {
        const r = (await all(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw, COALESCE(SUM(cost_usd),0) c, COUNT(*) n, COUNT(cost_usd) p FROM usage_log WHERE ts >= ?${chatId ? ' AND chat_id = ?' : ''}`, chatId ? [sinceMs, chatId] : [sinceMs]))[0]!
        return { inputTokens: Number(r['i']), outputTokens: Number(r['o']), cacheReadTokens: Number(r['cr']), cacheWriteTokens: Number(r['cw']), costUsd: Number(r['c']), calls: Number(r['n']), pricedCalls: Number(r['p']) }
      },
      /** Grouped totals since a time. `by` picks the grouping; the label is the newest name seen for that key. */
      async grouped(by: 'friend' | 'workspace' | 'chat', sinceMs = 0, limit = 50): Promise<UsageGroup[]> {
        const [key, label] = by === 'friend' ? ['friend_id', 'friend_name'] : by === 'workspace' ? ['workspace_id', 'workspace_name'] : ['chat_id', 'chat_title']
        const rows = await all(`SELECT COALESCE(${key}, '?') k, (SELECT ${label} FROM usage_log u2 WHERE COALESCE(u2.${key}, '?') = COALESCE(usage_log.${key}, '?') ORDER BY u2.ts DESC LIMIT 1) l, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, COALESCE(SUM(cost_usd),0) c, COUNT(*) n, COUNT(cost_usd) p FROM usage_log WHERE ts >= ? GROUP BY k ORDER BY (SUM(input_tokens)+SUM(output_tokens)+SUM(cache_read_tokens)+SUM(cache_write_tokens)) DESC LIMIT ?`, [sinceMs, limit])
        return rows.map((r) => ({ key: String(r['k']), label: String(r['l'] ?? 'Unknown'), inputTokens: Number(r['i']), outputTokens: Number(r['o']), cacheReadTokens: Number(r['cr']), cacheWriteTokens: Number(r['cw']), costUsd: Number(r['c']), calls: Number(r['n']), pricedCalls: Number(r['p']) }))
      },
      /** Tokens and cost per local day for the last `days` days, oldest first, zero-filled. */
      async daily(days: number, nowMs = now()): Promise<{ day: string; tokens: number; costUsd: number }[]> {
        const start = new Date(nowMs); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1))
        const rows = await all("SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) t, COALESCE(SUM(cost_usd),0) c FROM usage_log WHERE ts >= ? GROUP BY d", [start.getTime()])
        const by = new Map(rows.map((r) => [String(r['d']), { tokens: Number(r['t']), costUsd: Number(r['c']) }]))
        const out: { day: string; tokens: number; costUsd: number }[] = []
        for (let i = 0; i < days; i++) {
          const d = new Date(start); d.setDate(start.getDate() + i)
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          out.push({ day, ...(by.get(day) ?? { tokens: 0, costUsd: 0 }) })
        }
        return out
      },
      async reset(): Promise<void> {
        await run('DELETE FROM usage_log')
      }
    },

    settings: {
      async get<T>(key: string, fallback: T): Promise<T> {
        const r = (await all('SELECT value_json FROM settings WHERE key = ?', [key]))[0]
        return r ? (JSON.parse(String(r['value_json'])) as T) : fallback
      },
      async set(key: string, value: unknown): Promise<void> {
        await run('INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', [key, JSON.stringify(value)])
      }
    },

    search: { async query(query: string, opts: { workspaceId?: string; limit?: number } = {}): Promise<SearchHit[]> {
      const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`)
      if (terms.length === 0) return []
      const args: (string | number)[] = [terms.join(' ')]
      let sql = `SELECT kind, ref_id, workspace_id, title, snippet(search_fts, 4, '[', ']', '…', 12) AS snip
                 FROM search_fts WHERE search_fts MATCH ?`
      if (opts.workspaceId) { sql += ' AND (workspace_id = ? OR workspace_id IS NULL)'; args.push(opts.workspaceId) }
      sql += ' ORDER BY rank LIMIT ?'
      args.push(opts.limit ?? 30)
      return (await all(sql, args)).map((r) => ({
        kind: r['kind'] as SearchHit['kind'], refId: String(r['ref_id']),
        workspaceId: (r['workspace_id'] as string | null) ?? null, title: String(r['title']), snippet: String(r['snip'] ?? '')
      }))
    } }
  }

  async function toMessageById(id: string): Promise<Message | null> {
    const r = (await all('SELECT * FROM messages WHERE id = ?', [id]))[0]
    return r ? toMessage(r) : null
  }
}

export type Repo = ReturnType<typeof createRepo>
