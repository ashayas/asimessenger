import type { Repo } from './db/repo'
import type { AgentEvent } from '@shared/events'
import type { Presence } from '@shared/status'

const PHASE_PRESENCE: Record<string, Presence> = { idle: 'online', done: 'online', thinking: 'busy', tool: 'busy', waiting: 'away', error: 'busy' }

interface ChatState {
  /** event id -> persisted message id (text, thinking, tool upserts) */
  byEventId: Map<string, string>
  textBuf: Map<string, string>
  flushTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Turns the normalized event stream into persisted messages and live chat status.
 * Events for one chat are processed strictly in order.
 */
export function createIngestor(repo: Repo, notify: (topic: string) => void) {
  const states = new Map<string, ChatState>()
  const queues = new Map<string, Promise<void>>()
  const state = (chatId: string): ChatState => {
    let s = states.get(chatId)
    if (!s) states.set(chatId, (s = { byEventId: new Map(), textBuf: new Map(), flushTimer: null }))
    return s
  }

  async function flush(chatId: string): Promise<void> {
    const s = state(chatId)
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
    for (const [eventId, text] of s.textBuf) {
      const mid = s.byEventId.get(eventId)
      if (mid) await repo.messages.update(mid, { text, body: { text } })
    }
    s.textBuf.clear()
    notify('messages')
  }

  async function handle(chatId: string, e: AgentEvent): Promise<void> {
    const s = state(chatId)
    switch (e.t) {
      case 'text':
      case 'thinking': {
        const key = `${e.t}:${e.id}`
        const prev = s.textBuf.get(key) ?? ''
        const text = prev + e.delta
        if (!s.byEventId.has(key)) {
          const m = await repo.messages.append({ chatId, role: 'agent', kind: e.t, body: { text }, text })
          s.byEventId.set(key, m.id)
          s.textBuf.set(key, text)
          notify('messages')
        } else {
          s.textBuf.set(key, text)
          if (!s.flushTimer) s.flushTimer = setTimeout(() => void flush(chatId), 80)
        }
        return
      }
      case 'tool': {
        await flush(chatId)
        const key = `tool:${e.id}`
        const mid = s.byEventId.get(key)
        const text = [e.title, e.command].filter(Boolean).join(' ')
        if (mid) await repo.messages.update(mid, { body: e, text })
        else s.byEventId.set(key, (await repo.messages.append({ chatId, role: 'agent', kind: 'tool', body: e, text })).id)
        notify('messages')
        return
      }
      case 'permission': {
        await flush(chatId)
        await repo.messages.append({ chatId, role: 'agent', kind: 'permission', body: { ...e, decision: null }, text: `${e.tool}: ${e.summary}` })
        await repo.chats.setStatus(chatId, 'away', `waiting on u: ${e.summary}`)
        notify('chats'); notify('messages')
        return
      }
      case 'question': {
        await flush(chatId)
        await repo.messages.append({ chatId, role: 'agent', kind: 'question', body: { ...e, answer: null }, text: e.prompt })
        await repo.chats.setStatus(chatId, 'away', 'has a question 4 u')
        notify('chats'); notify('messages')
        return
      }
      case 'attachment': {
        await flush(chatId)
        const m = await repo.messages.append({ chatId, role: 'agent', kind: 'attachment', body: e, text: e.name })
        await repo.attachments.add({ messageId: m.id, kind: e.kind, name: e.name, path: e.path ?? null, body: e.body ?? null })
        notify('messages')
        return
      }
      case 'open_url': {
        await repo.messages.append({ chatId, role: 'system', kind: 'open_url', body: e, text: e.url })
        notify('messages')
        return
      }
      case 'status': {
        await repo.chats.setStatus(chatId, PHASE_PRESENCE[e.phase] ?? 'online', e.detail ?? null)
        notify('chats')
        return
      }
      case 'usage':
        return
      case 'turn_end': {
        await flush(chatId)
        s.byEventId.clear()
        const text = e.reason === 'interrupted' ? 'stopped' : e.reason === 'error' ? `x_x ${e.error ?? 'error'}` : null
        if (e.reason === 'error') await repo.messages.append({ chatId, role: 'system', kind: 'error', body: { error: e.error ?? 'error' }, text: e.error ?? 'error' })
        await repo.chats.setStatus(chatId, 'online', text)
        notify('chats'); notify('messages')
        return
      }
    }
  }

  return {
    /** Queue an event; resolves once it has been persisted. */
    ingest(chatId: string, e: AgentEvent): Promise<void> {
      const prev = queues.get(chatId) ?? Promise.resolve()
      const next = prev.then(() => handle(chatId, e)).catch((err) => console.error('[ingest]', err))
      queues.set(chatId, next)
      return next
    },
    async idle(chatId: string): Promise<void> {
      await queues.get(chatId)
    }
  }
}

export type Ingestor = ReturnType<typeof createIngestor>
