import type { Repo } from './db/repo'
import type { Message } from '@shared/models'
import { broadcastChanged } from './ipc'

const TITLE_MAX = 42
const autoTitle = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX - 1) + '…' : one
}

/** A responder turns a user message into agent replies. Replaced by real harnesses in the harness commits. */
export interface Responder {
  respond(args: { chatId: string; text: string }): Promise<void>
}

export function createChatService(repo: Repo) {
  const echo: Responder = {
    async respond({ chatId, text }) {
      await new Promise((r) => setTimeout(r, 150))
      await repo.messages.append({ chatId, role: 'agent', kind: 'text', body: { text: `echo: ${text}` }, text: `echo: ${text}` })
      broadcastChanged('messages')
    }
  }

  return {
    async send(chatId: string, text: string): Promise<Message | null> {
      const clean = text.trim()
      if (!clean) return null
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const friend = await repo.friends.get(chat.friendId)
      const msg = await repo.messages.append({ chatId, role: 'user', kind: 'text', body: { text: clean }, text: clean })
      if (chat.title === 'New chat') await repo.chats.rename(chatId, autoTitle(clean))
      broadcastChanged('messages')
      if (friend?.harness === 'echo') void echo.respond({ chatId, text: clean })
      return msg
    }
  }
}

export type ChatService = ReturnType<typeof createChatService>
