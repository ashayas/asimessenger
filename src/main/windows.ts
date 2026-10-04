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
  const win = new BrowserWindow(baseOptions({ width: 560, height: 520, minWidth: 460, minHeight: 360, title: 'Options' }))
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
