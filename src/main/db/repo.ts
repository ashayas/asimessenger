import { randomUUID } from 'node:crypto'
import type { Db } from './db'
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
  title: String(r['title']), harnessSessionId: (r['harness_session_id'] as string | null) ?? null,
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
      async create(c: { workspaceId: string; friendId: string; title?: string; mode?: Mode }): Promise<Chat> {
        const id = randomUUID()
        const t = now()
        const mode = c.mode ?? (await all('SELECT default_mode FROM friends WHERE id = ?', [c.friendId]))[0]?.['default_mode'] ?? 'ask'
        await run(
          'INSERT INTO chats(id,workspace_id,friend_id,title,mode,created_at,last_activity_at) VALUES (?,?,?,?,?,?,?)',
          [id, c.workspaceId, c.friendId, c.title ?? 'New chat', mode as string, t, t]
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
      async rename(id: string, title: string): Promise<void> {
        await run('UPDATE chats SET title = ? WHERE id = ?', [title, id])
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
