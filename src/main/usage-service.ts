import type { Repo } from './db/repo'
import { probeClaude, probeCodex, type CodexAccount, type ProbeOptions } from './usage-probe'
import type { LimitProvider, LimitsSnapshot, UsageOverview } from '@shared/usage'

export type UsageRange = 'today' | 'week' | 'month' | 'all'

const startOfToday = (nowMs: number) => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime() }
const DAY = 86_400_000

/** Spend (what each agent reported using) plus the agents' own subscription limits, in one place. */
export function createUsageService(deps: {
  repo: Repo
  notify: (topic: string) => void
  /** Where to find each CLI (login-shell PATH); null when it is not installed. */
  probeOptions: (provider: LimitProvider) => Promise<ProbeOptions | null>
  now?: () => number
}) {
  const { repo, notify } = deps
  const now = deps.now ?? Date.now

  return {
    async overview(range: UsageRange = 'week'): Promise<UsageOverview> {
      const t = now()
      const since = { today: startOfToday(t), week: t - 7 * DAY, month: t - 30 * DAY, all: 0 }
      const [today, week, month, all, byFriend, byWorkspace, topChats, daily, claude, codex, codexAccount] = await Promise.all([
        repo.usage.totals(since.today), repo.usage.totals(since.week), repo.usage.totals(since.month), repo.usage.totals(0),
        repo.usage.grouped('friend', since[range]), repo.usage.grouped('workspace', since[range]), repo.usage.grouped('chat', since[range], 8),
        repo.usage.daily(14, t),
        repo.settings.get<LimitsSnapshot | null>('limits:claude', null), repo.settings.get<LimitsSnapshot | null>('limits:codex', null),
        repo.settings.get<CodexAccount | null>('account:codex', null)
      ])
      return { today, week, month, all, byFriend, byWorkspace, topChats, daily, limits: [claude, codex].filter((l): l is LimitsSnapshot => !!l), codexAccount }
    },

    /**
     * Ask an agent for its current limits. Codex answers for free. Claude needs one tiny model call, so this is only run
     * when you press Refresh, never in the background.
     */
    async refresh(provider: LimitProvider): Promise<void> {
      const o = await deps.probeOptions(provider)
      if (!o) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed`)
      if (provider === 'codex') {
        const { limits, account } = await probeCodex(o, now())
        if (limits) await repo.settings.set('limits:codex', { provider: 'codex', plan: limits.plan ?? null, windows: limits.windows, status: limits.status ?? null, note: limits.note ?? null, asOf: now() } satisfies LimitsSnapshot)
        if (account) await repo.settings.set('account:codex', account)
      } else {
        const { limits, usage } = await probeClaude(o)
        await repo.settings.set('limits:claude', { provider: 'claude', plan: limits.plan ?? null, windows: limits.windows, status: limits.status ?? null, note: limits.note ?? null, asOf: now() } satisfies LimitsSnapshot)
        if (usage) await repo.usage.record({ chatId: null, chatTitle: 'Limit check', friendName: 'Claude Code', harness: 'claude', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, costUsd: usage.costUsd })
      }
      notify('usage')
    },

    /** Forget recorded spend (limits and the Codex account view are the agents' data, so they stay). */
    async reset(): Promise<void> {
      await repo.usage.reset()
      notify('usage')
    },

    async forChat(chatId: string) {
      return repo.usage.totals(0, chatId)
    }
  }
}

export type UsageService = ReturnType<typeof createUsageService>
