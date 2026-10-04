import type { Repo } from './db/repo'
import type { Message } from '@shared/models'
import type { PermDecision, UserTurn } from '@shared/events'
import type { HarnessManager } from '../harness/manager'
import type { Ingestor } from './ingest'

const TITLE_MAX = 42
const autoTitle = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX - 1) + '…' : one
}

export function createChatService(deps: { repo: Repo; manager: HarnessManager; ingestor: Ingestor; notify: (topic: string) => void }) {
  const { repo, manager, ingestor, notify } = deps

  return {
    async send(chatId: string, text: string, quote?: UserTurn['quote']): Promise<Message | null> {
      const clean = text.trim()
      if (!clean) return null
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const friend = await repo.friends.get(chat.friendId)
      if (!friend) throw new Error(`unknown friend ${chat.friendId}`)
      const ws = await repo.workspaces.get(chat.workspaceId)
      const msg = await repo.messages.append({ chatId, role: 'user', kind: 'text', body: { text: clean, quote }, text: clean })
      if (chat.title === 'New chat') await repo.chats.rename(chatId, autoTitle(clean))
      notify('messages')
      try {
        await manager.send(chat, friend, ws?.path ?? process.cwd(), { text: clean, quote })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await repo.messages.append({ chatId, role: 'system', kind: 'error', body: { error: message }, text: message })
        await repo.chats.setStatus(chatId, 'online', `x_x ${message}`)
        notify('messages'); notify('chats')
      }
      return msg
    },

    /** Nudge. */
    async interrupt(chatId: string): Promise<void> {
      await manager.interrupt(chatId)
    },

    /** Answer a permission request or question card. */
    async respond(chatId: string, reqId: string, answer: PermDecision | string, reason?: string): Promise<void> {
      await ingestor.idle(chatId)
      const msgs = await repo.messages.list(chatId)
      const card = msgs.find((m) => (m.kind === 'permission' || m.kind === 'question') && (m.body as { reqId?: string }).reqId === reqId)
      if (card) {
        const body = card.body as Record<string, unknown>
        await repo.messages.update(card.id, { body: card.kind === 'permission' ? { ...body, decision: answer, reason: reason ?? null } : { ...body, answer } })
      }
      await repo.chats.setStatus(chatId, 'busy', null)
      notify('messages'); notify('chats')
      manager.respond(chatId, reqId, answer, reason)
    }
  }
}

export type ChatService = ReturnType<typeof createChatService>
