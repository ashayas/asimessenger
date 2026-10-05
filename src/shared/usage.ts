/** Plan limits and spend, as the agents themselves report them. */

export type LimitProvider = 'claude' | 'codex'

/** One rolling allowance window, e.g. the 5-hour or weekly limit of a subscription. */
export interface LimitWindow {
  /** Stable id: five_hour, seven_day, or a window of N minutes for others. */
  id: string
  label: string
  /** 0..100 */
  usedPercent: number
  /** Unix seconds when this window resets, if the agent says. */
  resetsAt: number | null
}

/** The latest limits an agent told us about for an account, with when we learned it. */
export interface LimitsSnapshot {
  provider: LimitProvider
  plan: string | null
  windows: LimitWindow[]
  /** allowed, or why not (rate limited, out of credits...). */
  status: string | null
  /** Extra account facts worth one line, such as credits left. */
  note: string | null
  /** Unix ms we received it. */
  asOf: number
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Sum of the costs agents reported. Agents that report none contribute nothing here, which is not the same as free. */
  costUsd: number
  /** How many recorded calls carried a cost, out of all calls. */
  calls: number
  pricedCalls: number
}

export const EMPTY_TOTALS: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0, pricedCalls: 0 }

export const totalTokens = (t: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens

export interface UsageGroup extends UsageTotals {
  key: string
  label: string
}

export interface UsageOverview {
  today: UsageTotals
  week: UsageTotals
  month: UsageTotals
  all: UsageTotals
  byFriend: UsageGroup[]
  byWorkspace: UsageGroup[]
  topChats: UsageGroup[]
  /** Last 14 local days, oldest first, zero-filled. */
  daily: { day: string; tokens: number; costUsd: number }[]
  limits: LimitsSnapshot[]
  /** Codex tells us about the whole account, including work done outside this app. */
  codexAccount: { lifetimeTokens: number; peakDailyTokens: number; last14: { day: string; tokens: number }[]; asOf: number } | null
}

/** 1.2k, 34k, 5.6M, 1.1B: short, with one decimal under 10 of a unit. */
export function fmtTokens(n: number): string {
  const f = (v: number, u: string) => `${v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toString()}${u}`
  if (n >= 1e9) return f(n / 1e9, 'B')
  if (n >= 1e6) return f(n / 1e6, 'M')
  if (n >= 1e3) return f(n / 1e3, 'k')
  return String(Math.round(n))
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString('en-US')}`
}

/** "in 3h 12m", "in 2d 4h", "now" for a reset time. */
export function fmtReset(resetsAtSec: number | null, nowMs = Date.now()): string {
  if (resetsAtSec === null) return ''
  const s = Math.round(resetsAtSec - nowMs / 1000)
  if (s <= 0) return 'reset'
  if (s < 3600) return `in ${Math.min(59, Math.max(1, Math.ceil(s / 60)))}m`
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h ${m % 60}m`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}

/** "just now", "4m ago", "3h ago", "2d ago" */
export function fmtAgo(ms: number, nowMs = Date.now()): string {
  const m = Math.floor((nowMs - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/** A window whose reset time has passed no longer describes the account: its usage has started over. */
export const windowIsStale = (w: LimitWindow, nowMs = Date.now()): boolean => w.resetsAt !== null && w.resetsAt * 1000 <= nowMs

export const WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' }

/** Two or three characters for tight spaces: 5h, wk. */
export function shortWindowLabel(w: Pick<LimitWindow, 'id' | 'label'>): string {
  if (w.id === 'five_hour') return '5h'
  if (w.id === 'seven_day') return 'wk'
  return w.label.replace('-hour', 'h').replace('-day', 'd').slice(0, 4)
}

/** Label for a window of N minutes: 300 -> 5-hour, 10080 -> Weekly. */
export function labelForMinutes(mins: number | null): { id: string; label: string } {
  if (mins === 300) return { id: 'five_hour', label: '5-hour' }
  if (mins === 10080) return { id: 'seven_day', label: 'Weekly' }
  if (mins === null) return { id: 'window', label: 'Limit' }
  if (mins % 1440 === 0) return { id: `d${mins / 1440}`, label: `${mins / 1440}-day` }
  if (mins % 60 === 0) return { id: `h${mins / 60}`, label: `${mins / 60}-hour` }
  return { id: `m${mins}`, label: `${mins}-min` }
}
