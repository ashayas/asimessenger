import type { AgentEvent } from '@shared/events'
import { WINDOW_LABELS } from '@shared/usage'

type Obj = Record<string, unknown>
export type LimitsEvent = Extract<AgentEvent, { t: 'limits' }>

/** Claude Code's `rate_limit_event`: the rolling 5-hour and weekly windows of the subscription, as a fraction 0..1. */
export function mapClaudeRateLimit(info: Obj): LimitsEvent | null {
  const windows = Object.entries((info['unifiedWindows'] ?? {}) as Record<string, Obj>)
    .filter(([, w]) => w && typeof w['utilization'] === 'number')
    .map(([id, w]) => ({ id, label: WINDOW_LABELS[id] ?? id.replace(/_/g, ' '), usedPercent: Math.round(Number(w['utilization']) * 100), resetsAt: typeof w['resetsAt'] === 'number' ? (w['resetsAt'] as number) : null }))
  if (windows.length === 0) return null
  const status = String(info['status'] ?? '')
  return { t: 'limits', provider: 'claude', plan: null, windows, status: status || null, note: info['isUsingOverage'] === true ? 'using extra usage' : null }
}
