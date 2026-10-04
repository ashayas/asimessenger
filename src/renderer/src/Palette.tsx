import { useEffect, useMemo, useRef, useState } from 'react'
import { KIND_LABEL, KIND_ORDER, type PaletteResult } from '@shared/search'
import { WindowFrame } from './ui/kit'

/** ⌘K: search chats, messages, attachments and friends; Enter jumps to the right window. */
export function Palette() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<PaletteResult[]>([])
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus(); return window.asi.search.onFocus(() => { input.current?.focus(); input.current?.select() }) }, [])
  useEffect(() => {
    const t = setTimeout(async () => { setResults(q.trim() ? await window.asi.search.all(q) : []); setSel(0) }, 80)
    return () => clearTimeout(t)
  }, [q])

  const groups = useMemo(() => KIND_ORDER.map((k) => ({ kind: k, items: results.filter((r) => r.kind === k) })).filter((g) => g.items.length), [results])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  const go = (r: PaletteResult | undefined) => { if (r) void window.asi.search.jump(r.target) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[sel]) }
    else if (e.key === 'Escape') window.close()
  }

  return (
    <WindowFrame title="Search everything">
      <div className="palette">
        <input ref={input} className="field big" aria-label="Search" placeholder="Search chats, messages, attachments, friends…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoFocus />
        <div className="results" role="listbox" data-testid="results">
          {q.trim() && flat.length === 0 && <div className="empty">Nothing matches “{q}”.</div>}
          {!q.trim() && <div className="empty">Type to search across every workspace.</div>}
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="rgroup">{KIND_LABEL[g.kind]}</div>
              {g.items.map((r) => {
                const i = flat.indexOf(r)
                return (
                  <div key={`${r.kind}-${r.title}-${i}`} role="option" aria-selected={i === sel} className={`result${i === sel ? ' sel' : ''}`} data-kind={r.kind} onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
                    <div className="rmain">
                      <div className="rtitle">{r.title}</div>
                      {r.snippet ? <div className="rsnip">{r.snippet.replace(/\[|\]/g, '')}</div> : null}
                    </div>
                    <div className="rwhere">{r.workspaceName ? `${r.workspaceSlot ? `⌘${r.workspaceSlot} ` : ''}${r.workspaceName}` : ''}</div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="pfoot"><span><kbd>↵</kbd> jump</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </WindowFrame>
  )
}
