import { useUsage } from './usage-hooks'
import { Meter, PROVIDER_NAME, limitsTitle, spendLine } from './UsageParts'

/** Always-visible usage on the buddy list: each agent's subscription windows, and today's spend. Click for the full picture. */
export function UsageStrip() {
  const u = useUsage('today')
  if (!u) return null
  return (
    <button className="usage-strip" data-testid="usage-strip" onClick={() => void window.asi.usage.open()} title="Open Usage (⌘U)">
      {u.limits.map((l) => (
        <span className="u-row" key={l.provider} title={limitsTitle(l)} data-provider={l.provider}>
          <b className="u-name">{PROVIDER_NAME[l.provider]}</b>
          {l.windows.map((w) => <Meter key={w.id} w={w} compact />)}
        </span>
      ))}
      <span className="u-row u-spend">
        <b className="u-name">Today</b>
        <span className="u-text" data-testid="usage-today">{spendLine(u.today)}</span>
        <span className="u-more">Usage ›</span>
      </span>
    </button>
  )
}
