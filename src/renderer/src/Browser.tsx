import { useEffect, useState } from 'react'
import { BROWSER_CHROME_HEIGHT, type BrowserState } from '@shared/browser'

/** Chrome for the in-app browser: tabs and an address bar. The page itself is a native view below. */
export function Browser() {
  const [st, setSt] = useState<BrowserState>({ tabs: [], active: null })
  const [addr, setAddr] = useState('')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    void window.asi.browser.state().then(setSt)
    return window.asi.browser.onState(setSt)
  }, [])
  const tab = st.tabs.find((t) => t.id === st.active)
  useEffect(() => { if (!editing) setAddr(tab?.url === 'about:blank' ? '' : (tab?.url ?? '')) }, [tab?.url, editing])
  useEffect(() => { document.title = tab?.title ? `${tab.title} · Browser` : 'Browser' }, [tab?.title])

  return (
    <div className="browser-chrome" style={{ height: BROWSER_CHROME_HEIGHT }}>
      <div className="titlebar"><span className="t">{tab?.title ?? 'Browser'}</span></div>
      <div className="btabs" role="tablist">
        {st.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === st.active} className={`btab${t.id === st.active ? ' sel' : ''}`} data-url={t.url} onClick={() => void window.asi.browser.select(t.id)}>
            <span className="bt-title">{t.loading ? '⏳ ' : ''}{t.title}</span>
            <button aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); void window.asi.browser.closeTab(t.id) }}>×</button>
          </div>
        ))}
        <button className="btab-new" aria-label="New tab" onClick={() => void window.asi.browser.newTab()}>＋</button>
      </div>
      <form className="baddr" onSubmit={(e) => { e.preventDefault(); void window.asi.browser.navigate(addr); setEditing(false) }}>
        <button type="button" aria-label="Back" disabled={!tab?.canGoBack} onClick={() => void window.asi.browser.back()}>◀</button>
        <button type="button" aria-label="Forward" disabled={!tab?.canGoForward} onClick={() => void window.asi.browser.forward()}>▶</button>
        <button type="button" aria-label="Reload" onClick={() => void window.asi.browser.reload()}>⟳</button>
        <input className="field" aria-label="Address" value={addr} placeholder="Search or enter a web address" onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => setAddr(e.target.value)} />
        <button type="button" aria-label="Open in your default browser" title="Open in your default browser" disabled={!tab?.url || tab.url === 'about:blank'} onClick={() => tab && void window.asi.browser.openExternal(tab.url)}>↗</button>
      </form>
    </div>
  )
}
