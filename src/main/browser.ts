import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import { BROWSER_CHROME_HEIGHT } from '@shared/browser'
import { isAllowedNavigation, normalizeUrl, type BrowserState, type TabState } from '@shared/browser'

interface Tab {
  id: number
  view: WebContentsView
}

/**
 * The in-app browser: our own chrome (tabs + address bar, a normal renderer page) with one sandboxed
 * WebContentsView per tab underneath. Own session partition, no preload, no permissions, web URLs only.
 */
export function createBrowserManager(makeWindow: () => BrowserWindow) {
  let win: BrowserWindow | null = null
  const tabs = new Map<number, Tab>()
  let active: number | null = null
  let nextId = 1

  const ses = () => {
    const s = session.fromPartition('persist:asi-browser')
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    s.setPermissionCheckHandler(() => false)
    return s
  }

  const tabState = (t: Tab): TabState => {
    const wc = t.view.webContents
    return { id: t.id, title: wc.getTitle() || wc.getURL() || 'New tab', url: wc.getURL(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }
  }
  const state = (): BrowserState => ({ tabs: [...tabs.values()].map(tabState), active })
  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('asi:browser-state', state()) }

  function layout(): void {
    if (!win || win.isDestroyed()) return
    const [w, h] = win.getContentSize() as [number, number]
    for (const t of tabs.values()) {
      t.view.setBounds({ x: 0, y: BROWSER_CHROME_HEIGHT, width: w, height: Math.max(0, h - BROWSER_CHROME_HEIGHT) })
      t.view.setVisible(t.id === active)
    }
  }

  function ensureWindow(): BrowserWindow {
    if (win && !win.isDestroyed()) return win
    win = makeWindow()
    win.on('resize', layout)
    win.on('closed', () => {
      for (const t of tabs.values()) if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
      tabs.clear()
      active = null
      win = null
    })
    return win
  }

  function newTab(url: string): number {
    const w = ensureWindow()
    const view = new WebContentsView({ webPreferences: { session: ses(), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const id = nextId++
    const tab: Tab = { id, view }
    tabs.set(id, tab)
    w.contentView.addChildView(view)
    const wc = view.webContents
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) wc.on(ev as 'did-navigate', push)
    const guard = (e: { preventDefault(): void }, to: string) => { if (!isAllowedNavigation(to)) e.preventDefault() }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.setWindowOpenHandler(({ url: to }) => {
      if (isAllowedNavigation(to)) select(newTab(to))
      return { action: 'deny' }
    })
    active = id
    layout()
    const target = normalizeUrl(url)
    if (isAllowedNavigation(target)) void wc.loadURL(target).catch(() => {})
    push()
    return id
  }

  function select(id: number): void {
    if (!tabs.has(id)) return
    active = id
    layout()
    push()
  }

  function closeTab(id: number): void {
    const t = tabs.get(id)
    if (!t || !win) return
    win.contentView.removeChildView(t.view)
    if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    tabs.delete(id)
    if (tabs.size === 0) return void win.close()
    if (active === id) active = [...tabs.keys()].at(-1) ?? null
    layout()
    push()
  }

  const cur = () => (active !== null ? tabs.get(active)?.view.webContents : undefined)

  return {
    /** Open a URL in a new tab (creating the window if needed) and focus it. */
    open(url: string): void {
      newTab(url)
      const w = ensureWindow()
      w.show()
      w.focus()
    },
    newTab: (url = 'about:blank') => newTab(url),
    select,
    closeTab,
    navigate(input: string): void {
      const target = normalizeUrl(input)
      if (isAllowedNavigation(target)) void cur()?.loadURL(target).catch(() => {})
    },
    back: () => cur()?.navigationHistory.goBack(),
    forward: () => cur()?.navigationHistory.goForward(),
    reload: () => cur()?.reload(),
    state,
    layout,
    openExternal(url: string): void { if (isAllowedNavigation(url)) void shell.openExternal(url) },
    /** For tests: URLs currently loaded in each tab. */
    urls: (): string[] => [...tabs.values()].map((t) => t.view.webContents.getURL())
  }
}

export type BrowserManager = ReturnType<typeof createBrowserManager>
