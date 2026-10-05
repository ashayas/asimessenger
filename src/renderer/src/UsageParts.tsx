import { shortWindowLabel, fmtAgo, fmtCost, fmtReset, fmtTokens, totalTokens, windowIsStale, type LimitsSnapshot, type LimitWindow, type UsageTotals } from '@shared/usage'

const tone = (pct: number) => (pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'ok')

/** One allowance window as a small meter. A window whose reset time has passed shows as reset, not as its old number. */
export function Meter({ w, compact = false }: { w: LimitWindow; compact?: boolean }) {
  const stale = windowIsStale(w)
  const pct = stale ? 0 : Math.min(100, Math.max(0, w.usedPercent))
  return (
    <div className={`meter ${stale ? 'stale' : tone(pct)}${compact ? ' compact' : ''}`} data-window={w.id} data-percent={stale ? 'reset' : pct}>
      <span className="m-label">{compact ? shortWindowLabel(w) : w.label}</span>
      <span className="m-track" role="progressbar" aria-label={`${w.label} limit used`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span className="m-fill" style={{ width: `${pct}%` }} /></span>
      <span className="m-pct">{stale ? 'reset' : `${pct}%`}</span>
      {compact ? null : <span className="m-reset">{stale ? 'window has reset, usage starts again' : w.resetsAt ? `resets ${fmtReset(w.resetsAt)}` : ''}</span>}
    </div>
  )
}

export const PROVIDER_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

export function limitsTitle(l: LimitsSnapshot): string {
  return `${PROVIDER_NAME[l.provider]}${l.plan ? ` · ${l.plan}` : ''} · as of ${fmtAgo(l.asOf)}`
}

/** "34k tokens · $0.04", or without a cost when the agent reports none. */
export function spendLine(t: UsageTotals): string {
  const tok = `${fmtTokens(totalTokens(t))} tokens`
  if (t.calls === 0) return 'no usage yet'
  return t.pricedCalls === 0 ? tok : t.pricedCalls < t.calls ? `${tok} · ${fmtCost(t.costUsd)}+` : `${tok} · ${fmtCost(t.costUsd)}`
}
