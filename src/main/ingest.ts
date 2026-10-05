import type { LimitsSnapshot } from '@shared/usage'
import { cleanTitle } from '@shared/title'
import type { Repo } from './db/repo'
import type { AgentEvent, Risk } from '@shared/events'
import type { Presence } from '@shared/status'
import { heuristicRisk } from '@shared/safety'
import { statusLine, type Lettering } from '@shared/status-text'

const PHASE_PRESENCE: Record<string, Presence> = { idle: 'online', done: 'online', thinking: 'busy', tool: 'busy', waiting: 'away', error: 'busy' }

interface ChatState {
  /** event id -> persisted message id (text, thinking, tool upserts) */
  byEventId: Map<string, string>
  textBuf: Map<string, string>
  flushTimer: ReturnType<typeof setTimeout> | null
  lettering: Lettering | null
}

/**
 * Turns the normalized event stream into persisted messages and live chat status.
 * Events for one chat are processed strictly in order.
 */
export interface Attention {
  chatId: string
  kind: 'message' | 'permission' | 'question' | 'error'
  text: string
  risk?: string
  reqId?: string
}

export function createIngestor(repo: Repo, notify: (topic: string) => void, onAttention: (a: Attention) => void = () => {}, assessRisk?: (tool: string, summary: string) => Promise<Risk>, onTurnEnd: (chatId: string, reason: 'done' | 'interrupted' | 'error') => void = () => {}) {
  const states = new Map<string, ChatState>()
  const queues = new Map<string, Promise<void>>()
  const state = (chatId: string): ChatState => {
    let s = states.get(chatId)
    if (!s) states.set(chatId, (s = { byEventId: new Map(), textBuf: new Map(), flushTimer: null, lettering: null }))
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

  async function lettering(chatId: string): Promise<Lettering> {
    const s = state(chatId)
    if (!s.lettering) {
      const chat = await repo.chats.get(chatId)
      const friend = chat ? await repo.friends.get(chat.friendId) : null
      s.lettering = friend?.letteringStyle === 'plain' ? 'plain' : 'funky'
    }
    return s.lettering
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
        const risk = e.risk ?? (await (assessRisk?.(e.tool, e.summary) ?? Promise.resolve(heuristicRisk(e.tool, e.summary))).catch(() => heuristicRisk(e.tool, e.summary)))
        await repo.messages.append({ chatId, role: 'agent', kind: 'permission', body: { ...e, risk, decision: null }, text: `${e.tool}: ${e.summary}` })
        await repo.chats.setStatus(chatId, 'away', statusLine({ phase: 'waiting', detail: e.summary }, await lettering(chatId)))
        notify('chats'); notify('messages')
        onAttention({ chatId, kind: 'permission', text: e.summary, risk, reqId: e.reqId })
        return
      }
      case 'question': {
        await flush(chatId)
        await repo.messages.append({ chatId, role: 'agent', kind: 'question', body: { ...e, answer: null }, text: e.prompt })
        await repo.chats.setStatus(chatId, 'away', statusLine({ phase: 'waiting', detail: 'question' }, await lettering(chatId)))
        notify('chats'); notify('messages')
        onAttention({ chatId, kind: 'question', text: e.prompt, reqId: e.reqId })
        return
      }
      case 'attachment': {
        await flush(chatId)
        const m = await repo.messages.append({ chatId, role: 'agent', kind: 'attachment', body: e, text: e.name })
        await repo.attachments.add({ messageId: m.id, kind: e.kind, name: e.name, path: e.path ?? null, body: e.body ?? null })
        notify('messages')
        return
      }
      case 'links': {
        await flush(chatId)
        await repo.messages.append({ chatId, role: 'agent', kind: 'links', body: e, text: e.items.map((i) => i.label).join(', ') })
        notify('messages')
        return
      }
      case 'open_url': {
        await repo.messages.append({ chatId, role: 'system', kind: 'open_url', body: e, text: e.url })
        notify('messages')
        return
      }
      case 'status': {
        await repo.chats.setStatus(chatId, PHASE_PRESENCE[e.phase] ?? 'online', statusLine({ phase: e.phase, detail: e.detail, kind: e.kind }, await lettering(chatId)))
        notify('chats')
        return
      }
      case 'title': {
        if (await repo.chats.setAutoTitle(chatId, cleanTitle(e.title), 'agent')) notify('chats')
        return
      }
      case 'usage': {
        // spend is recorded with the names of the chat, agent and workspace as they are now, so totals outlive any of them
        const chat = await repo.chats.get(chatId)
        const friend = chat ? await repo.friends.get(chat.friendId) : null
        const ws = chat ? await repo.workspaces.get(chat.workspaceId) : null
        await repo.usage.record({ chatId, chatTitle: chat?.title, friendId: friend?.id, friendName: friend?.displayName, workspaceId: ws?.id, workspaceName: ws?.name, harness: friend?.harness, model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cacheReadTokens: e.cacheReadTokens, cacheWriteTokens: e.cacheWriteTokens, costUsd: e.costUsd })
        notify('usage')
        return
      }
      case 'limits': {
        await repo.settings.set(`limits:${e.provider}`, { provider: e.provider, plan: e.plan ?? null, windows: e.windows.map((w) => ({ ...w })), status: e.status ?? null, note: e.note ?? null, asOf: Date.now() } satisfies LimitsSnapshot)
        notify('usage')
        return
      }
      case 'turn_end': {
        await flush(chatId)
        s.byEventId.clear()
        const style = await lettering(chatId)
        const text = e.reason === 'interrupted' ? statusLine({ phase: 'stopped' }, style) : e.reason === 'error' ? statusLine({ phase: 'error', detail: e.error ?? 'error' }, style) : statusLine({ phase: 'done' }, style)
        if (e.reason === 'error') await repo.messages.append({ chatId, role: 'system', kind: 'error', body: { error: e.error ?? 'error' }, text: e.error ?? 'error' })
        await repo.chats.setStatus(chatId, 'online', text)
        notify('chats'); notify('messages')
        if (e.reason === 'error') onAttention({ chatId, kind: 'error', text: e.error ?? 'error' })
        else if (e.reason === 'done') {
          const last = (await repo.messages.list(chatId)).filter((m) => m.role === 'agent' && m.kind === 'text').at(-1)
          if (last?.text) onAttention({ chatId, kind: 'message', text: last.text })
        }
        onTurnEnd(chatId, e.reason)
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
