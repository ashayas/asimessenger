import { app, BrowserWindow, screen } from 'electron'
import type { Repo } from './db/repo'
import type { Attention } from './ingest'
import { openChatWindow, windowFor } from './windows'
import { loadRoute, toastOptions } from './windows'

const TOAST_MS = 9000
const toasts = new Set<BrowserWindow>()

export function totalUnread(chats: { unreadCount: number }[]): number {
  return chats.reduce((n, c) => n + c.unreadCount, 0)
}

/** Dock badge = total unread across every chat. */
export async function refreshBadge(repo: Repo): Promise<number> {
  const n = totalUnread(await repo.chats.list())
  if (process.platform === 'darwin') app.dock?.setBadge(n > 0 ? String(n) : '')
  return n
}

/** Opens the chat with the oldest unread activity (⌘⇧U). */
export async function openNextUnread(repo: Repo): Promise<string | null> {
  const next = (await repo.chats.list()).filter((c) => c.unreadCount > 0).sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0]
  if (!next) return null
  openChatWindow(next.id)
  return next.id
}

/** Show a Messenger-style toast (and bounce the dock) unless you are already looking at that chat. */
export function createAttentionHandler(repo: Repo) {
  return async (a: Attention): Promise<void> => {
    const chat = await repo.chats.get(a.chatId)
    if (!chat) return
    const w = windowFor(a.chatId)
    if (w && !w.isDestroyed() && w.isFocused()) return // you are watching it; the transcript is enough
    await refreshBadge(repo)
    if (process.platform === 'darwin' && !BrowserWindow.getFocusedWindow()) app.dock?.bounce('informational')
    if (process.env['ASI_NO_TOAST']) return
    showToast(a)
  }
}

function showToast(a: Attention): void {
  const area = screen.getPrimaryDisplay().workArea
  const width = 320
  const height = 124
  const slot = [...toasts].filter((t) => !t.isDestroyed()).length
  const win = new BrowserWindow(toastOptions({ width, height, x: area.x + area.width - width - 14, y: area.y + area.height - height - 14 - slot * (height + 8) }))
  toasts.add(win)
  win.setAlwaysOnTop(true, 'floating')
  win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => toasts.delete(win))
  const q = new URLSearchParams({ chat: a.chatId, kind: a.kind, text: a.text.slice(0, 160), risk: a.risk ?? '', req: a.reqId ?? '' })
  loadRoute(win, `/toast?${q.toString()}`)
  setTimeout(() => { if (!win.isDestroyed()) win.close() }, TOAST_MS).unref()
}

export function closeToastsFor(chatId: string): void {
  for (const t of toasts) {
    if (t.isDestroyed()) continue
    if (t.webContents.getURL().includes(`chat=${chatId}`)) t.close()
  }
}
