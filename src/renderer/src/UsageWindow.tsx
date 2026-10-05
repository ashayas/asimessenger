import { useState } from 'react'
import { fmtAgo, fmtCost, fmtTokens, totalTokens, type UsageGroup, type UsageTotals } from '@shared/usage'
import { Btn, WindowFrame } from './ui/kit'
import { useUsage } from './usage-hooks'
import { Meter, PROVIDER_NAME } from './UsageParts'

type Range = 'today' | 'week' | 'month' | 'all'
const RANGES: { id: Range; label: string }[] = [{ id: 'today', label: 'Today' }, { id: 'week', label: '7 days' }, { id: 'month', label: '30 days' }, { id: 'all', label: 'All time' }]

const msg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))

function Totals({ label, t }: { label: string; t: UsageTotals }) {
  return (
    <div className="u-card" data-testid={`total-${label}`}>
      <div className="u-card-h">{label}</div>
      <div className="u-big">{fmtTokens(totalTokens(t))}<span> tokens</span></div>
      <div className="u-sub">{t.pricedCalls === 0 ? (t.calls ? 'cost not reported' : '') : `${fmtCost(t.costUsd)}${t.pricedCalls < t.calls ? ' reported' : ''}`}</div>
    </div>
  )
}

function Table({ rows, empty }: { rows: UsageGroup[]; empty: string }) {
  if (rows.length === 0) return <div className="u-empty">{empty}</div>
  return (
    <div className="u-table">
      <table>
        <thead><tr><th>Name</th><th>Tokens</th><th>In</th><th>Out</th><th>Cached</th><th>Cost</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>{fmtTokens(totalTokens(r))}</td>
              <td>{fmtTokens(r.inputTokens)}</td>
              <td>{fmtTokens(r.outputTokens)}</td>
              <td>{fmtTokens(r.cacheReadTokens + r.cacheWriteTokens)}</td>
              <td>{r.pricedCalls === 0 ? <span className="u-dim" title="This agent does not report cost">not reported</span> : `${fmtCost(r.costUsd)}${r.pricedCalls < r.calls ? '+' : ''}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Chart({ days }: { days: { day: string; tokens: number; costUsd: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  return (
    <div className="u-chart" role="img" aria-label="Tokens per day, last 14 days">
      {days.map((d) => (
        <div className="u-bar" key={d.day} title={`${d.day}: ${fmtTokens(d.tokens)} tokens${d.costUsd ? ` · ${fmtCost(d.costUsd)}` : ''}`}>
          <span className="u-fill" style={{ height: `${Math.max(d.tokens ? 4 : 0, (d.tokens / max) * 100)}%` }} />
          <span className="u-day">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  )
}

export function UsageWindow() {
  const [range, setRange] = useState<Range>('week')
  const u = useUsage(range)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const refresh = async (p: 'claude' | 'codex') => {
    setBusy(p); setNote(null)
    try { await window.asi.usage.refresh(p); setNote({ ok: true, text: `${PROVIDER_NAME[p]} limits updated.` }) } catch (e) { setNote({ ok: false, text: msg(e) }) } finally { setBusy(null) }
  }

  if (!u) return <WindowFrame title="Usage"><div className="empty">Loading…</div></WindowFrame>
  const lim = (p: string) => u.limits.find((l) => l.provider === p)
  return (
    <WindowFrame title="Usage">
      <div className="usage" data-testid="usage-window">
        <h2>Plan limits</h2>
        <p className="u-help">What your subscriptions say you have used, straight from Claude Code and Codex. It includes work done outside this app.</p>
        <div className="u-limits">
          {(['claude', 'codex'] as const).map((p) => {
            const l = lim(p)
            return (
              <section className="u-card u-limit" key={p} data-provider={p}>
                <div className="u-limit-h">
                  <b>{PROVIDER_NAME[p]}</b>{l?.plan ? <span className="u-plan">{l.plan}</span> : null}
                  <span className="grow" />
                  <Btn disabled={busy !== null} onClick={() => void refresh(p)} title={p === 'claude' ? 'Claude only reports its limits while it answers, so this sends one tiny request (a fraction of a cent)' : 'Ask Codex for the current limits (free)'}>{busy === p ? 'Checking…' : 'Refresh'}</Btn>
                </div>
                {l ? (
                  <>
                    {l.windows.map((w) => <Meter key={w.id} w={w} />)}
                    <div className="u-sub">{[l.status && l.status !== 'allowed' ? l.status : null, l.note, `as of ${fmtAgo(l.asOf)}`].filter(Boolean).join(' · ')}</div>
                  </>
                ) : (
                  <div className="u-empty">{p === 'claude' ? 'Not seen yet. It appears after your next Claude Code turn, or press Refresh.' : 'Not seen yet. Press Refresh.'}</div>
                )}
              </section>
            )
          })}
        </div>
        {note ? <div className={note.ok ? 'note ok' : 'note bad'} role="status">{note.text}</div> : null}

        <h2>Spend in this app</h2>
        <p className="u-help">Tokens each agent used for the chats you ran here. Cost is shown only where the agent reports one (Claude Code and Pi do; Codex and OpenCode do not), so a missing cost means unknown, not free.</p>
        <div className="u-totals">
          <Totals label="Today" t={u.today} />
          <Totals label="7 days" t={u.week} />
          <Totals label="30 days" t={u.month} />
          <Totals label="All time" t={u.all} />
        </div>
        <Chart days={u.daily} />

        <div className="u-range" role="tablist" aria-label="Range">
          {RANGES.map((r) => <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? 'sel' : ''} onClick={() => setRange(r.id)}>{r.label}</button>)}
        </div>
        <h3>By agent</h3>
        <Table rows={u.byFriend} empty="Nothing recorded in this range." />
        <h3>By workspace</h3>
        <Table rows={u.byWorkspace} empty="Nothing recorded in this range." />
        <h3>Busiest chats</h3>
        <Table rows={u.topChats} empty="Nothing recorded in this range." />

        {u.codexAccount ? (
          <>
            <h2>Codex account, all clients</h2>
            <p className="u-help">Reported by Codex for the whole account, including the terminal and other machines. Refreshed {fmtAgo(u.codexAccount.asOf)}.</p>
            <div className="u-totals">
              <div className="u-card"><div className="u-card-h">Lifetime</div><div className="u-big">{fmtTokens(u.codexAccount.lifetimeTokens)}<span> tokens</span></div></div>
              <div className="u-card"><div className="u-card-h">Busiest day</div><div className="u-big">{fmtTokens(u.codexAccount.peakDailyTokens)}<span> tokens</span></div></div>
            </div>
            <Chart days={u.codexAccount.last14.map((d) => ({ ...d, costUsd: 0 }))} />
          </>
        ) : null}

        <div className="u-foot">
          {confirmReset ? (
            <><span>Forget recorded spend? Plan limits stay.</span> <Btn kind="danger" onClick={() => void window.asi.usage.reset().then(() => setConfirmReset(false))}>Forget spend</Btn> <Btn onClick={() => setConfirmReset(false)}>Cancel</Btn></>
          ) : <button className="linkish" onClick={() => setConfirmReset(true)}>Forget recorded spend…</button>}
        </div>
      </div>
    </WindowFrame>
  )
}
