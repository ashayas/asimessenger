import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/app'

const chatWindows = new Map<string, BrowserWindow>()
let contactsWindow: BrowserWindow | null = null

export function baseOptions(over: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindowConstructorOptions {
  return {
    title: APP_NAME,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 8 },
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true },
    ...over
  }
}

export function loadRoute(win: BrowserWindow, route: string): void {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(`${dev}#${route}`)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: route })
}

export function openContactsWindow(): BrowserWindow {
  if (contactsWindow && !contactsWindow.isDestroyed()) {
    contactsWindow.show()
    contactsWindow.focus()
    return contactsWindow
  }
  const win = new BrowserWindow(baseOptions({ width: 330, height: 720, minWidth: 260, minHeight: 360 }))
  contactsWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { contactsWindow = null })
  loadRoute(win, '/contacts')
  return win
}

/** One window per chat; opening an already-open chat focuses it. */
export function openChatWindow(chatId: string): BrowserWindow {
  const existing = chatWindows.get(chatId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }
  const offset = (chatWindows.size % 6) * 26
  const win = new BrowserWindow(baseOptions({ width: 680, height: 560, minWidth: 460, minHeight: 360, x: 380 + offset, y: 80 + offset }))
  chatWindows.set(chatId, win)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => chatWindows.delete(chatId))
  loadRoute(win, `/chat/${chatId}`)
  return win
}

export function windowFor(chatId: string): BrowserWindow | undefined {
  const w = chatWindows.get(chatId)
  return w && !w.isDestroyed() ? w : undefined
}

export function toastOptions(over: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindowConstructorOptions {
  return {
    ...baseOptions({}), titleBarStyle: 'default', frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, hasShadow: true, ...over
  }
}

export function openChatWindowIds(): string[] {
  return [...chatWindows.entries()].filter(([, w]) => !w.isDestroyed()).map(([id]) => id)
}

let addFriendWindow: BrowserWindow | null = null
export function openAddFriendWindow(): BrowserWindow {
  if (addFriendWindow && !addFriendWindow.isDestroyed()) {
    addFriendWindow.show()
    addFriendWindow.focus()
    return addFriendWindow
  }
  const win = new BrowserWindow(baseOptions({ width: 500, height: 640, minWidth: 420, minHeight: 420, title: 'Add a Friend' }))
  addFriendWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { addFriendWindow = null })
  loadRoute(win, '/add-friend')
  return win
}

let optionsWindow: BrowserWindow | null = null
export function openOptionsWindow(): BrowserWindow {
  if (optionsWindow && !optionsWindow.isDestroyed()) {
    optionsWindow.show()
    optionsWindow.focus()
    return optionsWindow
  }
  const win = new BrowserWindow(baseOptions({ width: 620, height: 720, minWidth: 480, minHeight: 400, title: 'Options' }))
  optionsWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { optionsWindow = null })
  loadRoute(win, '/options')
  return win
}

/** The nudge shake: a quick decaying jitter of the window position. */
export function shakeWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || win.isFullScreen()) return
  const [x0, y0] = win.getPosition() as [number, number]
  const offsets = [14, -14, 11, -11, 8, -8, 5, -5, 2, -2, 0]
  let i = 0
  const timer = setInterval(() => {
    if (win.isDestroyed() || i >= offsets.length) return void clearInterval(timer)
    const o = offsets[i++]!
    win.setPosition(x0 + o, y0 + (i % 2 === 0 ? 3 : -3))
    if (i >= offsets.length) win.setPosition(x0, y0)
  }, 28)
}

const attachmentWindows = new Map<string, BrowserWindow>()
export function openAttachmentWindow(messageId: string, title: string): BrowserWindow {
  const existing = attachmentWindows.get(messageId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }
  const win = new BrowserWindow(baseOptions({ width: 760, height: 620, minWidth: 460, minHeight: 360, title }))
  attachmentWindows.set(messageId, win)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => attachmentWindows.delete(messageId))
  loadRoute(win, `/attachment/${messageId}`)
  return win
}

let searchWindow: BrowserWindow | null = null
export function openSearchWindow(): BrowserWindow {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.show()
    searchWindow.focus()
    searchWindow.webContents.send('asi:search-focus')
    return searchWindow
  }
  const win = new BrowserWindow(baseOptions({ width: 600, height: 440, minWidth: 420, minHeight: 300, title: 'Search everything', alwaysOnTop: true, center: true }))
  searchWindow = win
  win.once('ready-to-show', () => win.show())
  if (!process.env['ASI_NO_AUTOCLOSE']) win.on('blur', () => { if (!win.isDestroyed()) win.close() })
  win.on('closed', () => { searchWindow = null })
  loadRoute(win, '/search')
  return win
}

export function closeSearchWindow(): void {
  if (searchWindow && !searchWindow.isDestroyed()) searchWindow.close()
}

const doodleWindows = new Map<string, BrowserWindow>()
/** One Excalidraw window per workspace; chatId (optional) enables "Send to chat". */
export function openDoodleWindow(workspaceId: string, opts: { chatId?: string; name?: string } = {}): BrowserWindow {
  const existing = doodleWindows.get(workspaceId)
  const q = new URLSearchParams({ ...(opts.chatId ? { chat: opts.chatId } : {}), ...(opts.name ? { name: opts.name } : {}) }).toString()
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    existing.webContents.send('asi:doodle-open', { chatId: opts.chatId ?? null, name: opts.name ?? null })
    return existing
  }
  const win = new BrowserWindow(baseOptions({ width: 1000, height: 720, minWidth: 600, minHeight: 420, title: 'Doodle' }))
  doodleWindows.set(workspaceId, win)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => doodleWindows.delete(workspaceId))
  loadRoute(win, `/doodle/${workspaceId}${q ? `?${q}` : ''}`)
  return win
}

export function createBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow(baseOptions({ width: 1100, height: 760, minWidth: 600, minHeight: 400, title: 'Browser' }))
  win.once('ready-to-show', () => win.show())
  loadRoute(win, '/browser')
  return win
}

let onboardingWindow: BrowserWindow | null = null
export function openOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    return onboardingWindow
  }
  const win = new BrowserWindow(baseOptions({ width: 460, height: 700, minWidth: 420, minHeight: 560, title: 'Welcome to ASI Messenger' }))
  onboardingWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { onboardingWindow = null })
  loadRoute(win, '/welcome')
  return win
}

/** Opening a chat goes through one router so the "tabs vs windows" setting applies everywhere. */
let router: ((chatId: string) => void) | null = null
export function setChatRouter(fn: (chatId: string) => void): void { router = fn }
export function showChat(chatId: string): void { if (router) router(chatId); else openChatWindow(chatId) }

const tabsWindows = new Map<string, BrowserWindow>()
const tabsActive = new Map<string, string | null>()
/** Chats opened while a tabs window is still loading: its page cannot hear a message yet, so they wait here until it asks. */
const tabsQueue = new Map<string, string[]>()
const tabsReady = new Set<string>()

/** The tabs page is up: hand over everything queued while it loaded, and deliver later opens live. */
export function takePendingTabs(workspaceId: string): string[] {
  tabsReady.add(workspaceId)
  const q = tabsQueue.get(workspaceId) ?? []
  tabsQueue.delete(workspaceId)
  return q
}

/** One tabbed window per workspace. */
export function openTabsWindow(workspaceId: string, chatId: string): BrowserWindow {
  const existing = tabsWindows.get(workspaceId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    if (tabsReady.has(workspaceId)) existing.webContents.send('asi:tabs-open', { chatId })
    else tabsQueue.set(workspaceId, [...(tabsQueue.get(workspaceId) ?? []), chatId])
    return existing
  }
  const win = new BrowserWindow(baseOptions({ width: 760, height: 620, minWidth: 520, minHeight: 400, title: 'Chats' }))
  tabsWindows.set(workspaceId, win)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { tabsWindows.delete(workspaceId); tabsActive.delete(workspaceId); tabsQueue.delete(workspaceId); tabsReady.delete(workspaceId) })
  loadRoute(win, `/tabs/${workspaceId}?chat=${chatId}`)
  return win
}

export function setTabsActive(workspaceId: string, chatId: string | null): void { tabsActive.set(workspaceId, chatId) }

/** True when you are looking at this chat right now: its own window, or the active tab of a focused tabs window. */
export function isLookingAt(chatId: string): boolean {
  const w = windowFor(chatId)
  if (w && w.isFocused()) return true
  for (const [ws, win] of tabsWindows) if (!win.isDestroyed() && win.isFocused() && tabsActive.get(ws) === chatId) return true
  return false
}
