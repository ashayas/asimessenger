import type { Repo } from './db/repo'
import type { Message } from '@shared/models'
import type { PermDecision, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'
import { canUseMode, lockedReason } from '@shared/safety'
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

    /** Change a chat's permission mode. Dangerous needs the global switch AND the friend's opt-in. */
    async setMode(chatId: string, mode: Mode): Promise<void> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const friend = await repo.friends.get(chat.friendId)
      const state = { globalDangerous: await repo.settings.get('allowDangerous', false), friendDangerous: !!friend?.dangerousAllowed }
      if (!canUseMode(mode, state)) throw new Error(lockedReason(state) ?? 'that mode is not allowed')
      await repo.chats.setMode(chatId, mode)
      manager.setMode(chatId, mode)
      notify('chats')
    },

    /** Global switch. Turning it off drops every dangerous chat back to Ask and restarts those sessions. */
    async setGlobalDangerous(on: boolean): Promise<void> {
      await repo.settings.set('allowDangerous', on)
      notify('settings')
      if (!on) await this.revokeDangerous()
    },

    async setFriendDangerous(friendId: string, on: boolean): Promise<void> {
      await repo.friends.setDangerousAllowed(friendId, on)
      notify('friends')
      if (!on) await this.revokeDangerous(friendId)
    },

    async revokeDangerous(friendId?: string): Promise<void> {
      for (const c of await repo.chats.list(friendId ? { friendId } : {})) {
        if (c.mode !== 'dangerous') continue
        await repo.chats.setMode(c.id, 'ask')
        await manager.dispose(c.id) // a bypass-permissions process must not keep running
      }
      notify('chats')
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
