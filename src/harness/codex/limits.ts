import type { AgentEvent } from '@shared/events'
import { labelForMinutes } from '@shared/usage'

type Obj = Record<string, unknown>
export type LimitsEvent = Extract<AgentEvent, { t: 'limits' }>

/** Codex's RateLimitSnapshot (account/rateLimits/read and the updated notification) as our limits event. */
export function mapCodexRateLimits(rl: Obj | null | undefined): LimitsEvent | null {
  if (!rl) return null
  const windows = (['primary', 'secondary'] as const)
    .map((k) => rl[k] as Obj | null)
    .filter((w): w is Obj => !!w && typeof w['usedPercent'] === 'number')
    .map((w) => {
      const { id, label } = labelForMinutes(typeof w['windowDurationMins'] === 'number' ? w['windowDurationMins'] : null)
      return { id, label, usedPercent: Math.round(Number(w['usedPercent'])), resetsAt: typeof w['resetsAt'] === 'number' ? w['resetsAt'] : null }
    })
  if (windows.length === 0) return null
  const credits = rl['credits'] as Obj | null
  const note = credits && (credits['unlimited'] === true ? 'unlimited credits' : credits['hasCredits'] === true && credits['balance'] ? `${String(credits['balance'])} credits` : null)
  return {
    t: 'limits',
    provider: 'codex',
    plan: typeof rl['planType'] === 'string' ? rl['planType'] : null,
    windows,
    status: rl['rateLimitReachedType'] ? String(rl['rateLimitReachedType']) : rl['spendControlReached'] === true ? 'spend limit reached' : 'allowed',
    note: note || null
  }
}

/** Codex's per-thread counters, as what one update added. input includes cached tokens, so fresh input is the difference. */
export function codexUsageDelta(cur: Obj, prev: Obj | null): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const n = (o: Obj | null, k: string) => (o && typeof o[k] === 'number' ? (o[k] as number) : 0)
  const d = (k: string) => Math.max(0, n(cur, k) - n(prev, k))
  const cached = d('cachedInputTokens')
  return { inputTokens: Math.max(0, d('inputTokens') - cached), outputTokens: d('outputTokens'), cacheReadTokens: cached, cacheWriteTokens: d('cacheWriteInputTokens') }
}
