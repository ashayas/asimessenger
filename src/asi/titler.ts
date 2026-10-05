import type { Repo } from '../main/db/repo'
import { llmTitle } from './decider'

interface TitleModel { baseUrl: string; model: string; token: string | null; fetchImpl?: typeof fetch }

/**
 * After a chat's first exchange, ask the connected chat model for a better title than the first-message rule produced.
 * Never touches a title you typed or one the agent supplied, tries a chat at most twice, and never blocks or fails a turn.
 */
export function createTitler(repo: Repo, model: () => Promise<TitleModel | null>, write: typeof llmTitle = llmTitle) {
  const attempts = new Map<string, number>()
  return {
    async maybeRetitle(chatId: string): Promise<boolean> {
      try {
        if ((attempts.get(chatId) ?? 0) >= 2) return false
        const chat = await repo.chats.get(chatId)
        if (!chat || (chat.titleSource !== 'rule' && chat.titleSource !== 'default')) return false
        const friend = await repo.friends.get(chat.friendId)
        if (!friend || friend.harness === 'asi' || friend.harness === 'echo' || friend.harness === 'fake') return false
        const msgs = await repo.messages.list(chatId)
        const user = msgs.find((m) => m.role === 'user' && m.kind === 'text')?.text ?? msgs.find((m) => m.role === 'user' && m.kind === 'attachment')?.text
        const agent = msgs.find((m) => m.role === 'agent' && m.kind === 'text')?.text
        if (!user || !agent) return false
        const m = await model()
        if (!m) return false
        attempts.set(chatId, (attempts.get(chatId) ?? 0) + 1)
        const title = await write(m, user, agent)
        return title ? await repo.chats.setAutoTitle(chatId, title, 'model') : false
      } catch {
        return false // offline, bad key, rate limit: the rule title stays
      }
    }
  }
}

export type Titler = ReturnType<typeof createTitler>
