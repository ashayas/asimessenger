import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/app'
import { openDb } from './db/db'
import { createRepo } from './db/repo'
import { broadcastChanged, onChanged, registerRepoIpc } from './ipc'
import { closeToastsFor, createAttentionHandler, openNextUnread, refreshBadge } from './notifications'
import { HarnessManager } from '../harness/manager'
import { registerHarnesses } from '../harness/registry'
import { createIngestor } from './ingest'
import { closeSearchWindow, openSearchWindow, openAttachmentWindow, shakeWindow, openAddFriendWindow, openChatWindow, openContactsWindow, openOptionsWindow } from './windows'
import { addCustom, addPreset, availability, detectPresets, testAcp } from './friends-service'
import { createChatService } from './chat-service'
import { loadAttachment } from './attachments'
import { searchAll } from './search'
import { ensureDefaults } from './defaults'
import { installMenu } from './menu'

app.setName(APP_NAME)
if (process.env['ASI_USER_DATA']) app.setPath('userData', process.env['ASI_USER_DATA'])

const iconPath = join(import.meta.dirname, '../../build/icon.png')

app.whenReady().then(async () => {
  const db = await openDb(join(app.getPath('userData'), 'asi.db'))
  const repo = createRepo(db)
  if (!process.env['ASI_NO_SEED']) await ensureDefaults(repo)
  registerRepoIpc(repo)
  ipcMain.handle('dialog:pick-folder', async () => {
    // tests drive this without a native dialog
    if (process.env['ASI_TEST_FOLDER']) return process.env['ASI_TEST_FOLDER']
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  const attention = createAttentionHandler(repo)
  const ingestor = createIngestor(repo, broadcastChanged, (a) => void attention(a))
  let badgeTimer: ReturnType<typeof setTimeout> | null = null
  onChanged((topic) => {
    if (topic !== 'chats' && topic !== 'messages') return
    if (badgeTimer) clearTimeout(badgeTimer)
    badgeTimer = setTimeout(() => void refreshBadge(repo), 80)
  })
  void refreshBadge(repo)
  const manager = new HarnessManager({
    onEvent: (chatId, e) => void ingestor.ingest(chatId, e),
    onResumeId: (chatId, id) => void repo.chats.setSession(chatId, id)
  })
  registerHarnesses(manager)
  app.on('will-quit', () => void manager.disposeAll())
  const chat = createChatService({ repo, manager, ingestor, notify: broadcastChanged })
  ipcMain.handle('chat:send', (_e, chatId: string, text: string, quote?: { name: string; text: string }) => chat.send(chatId, text, quote))
  ipcMain.handle('safety:set-global-dangerous', (_e, on: boolean) => chat.setGlobalDangerous(on))
  ipcMain.handle('safety:set-friend-dangerous', (_e, id: string, on: boolean) => chat.setFriendDangerous(id, on))
  ipcMain.handle('window:open-options', () => { openOptionsWindow() })
  ipcMain.handle('chat:set-mode', (_e, chatId: string, mode: string) => chat.setMode(chatId, mode as never))
  ipcMain.handle('attachments:load', (_e, messageId: string) => loadAttachment(repo, messageId))
  ipcMain.handle('attachments:open', async (_e, messageId: string) => { const a = await loadAttachment(repo, messageId); openAttachmentWindow(messageId, a.name) })
  ipcMain.handle('dialog:pick-files', async () => {
    if (process.env['ASI_TEST_FILES']) return JSON.parse(process.env['ASI_TEST_FILES']) as string[]
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('chat:send-files', (_e, chatId: string, paths: string[], note?: string) => chat.sendFiles(chatId, paths, note))
  ipcMain.handle('window:open-search', () => { openSearchWindow() })
  ipcMain.handle('search:all', (_e, q: string) => searchAll(repo, q))
  ipcMain.handle('search:jump', async (_e, t: import('@shared/search').SearchTarget) => {
    closeSearchWindow()
    if ('workspaceId' in t && t.workspaceId) { await repo.settings.set('activeWorkspaceId', t.workspaceId); broadcastChanged('settings') }
    if (t.type === 'chat') openChatWindow(t.chatId)
    else if (t.type === 'attachment') { const a = await loadAttachment(repo, t.messageId); openAttachmentWindow(t.messageId, a.name) }
    else if (t.type === 'friend') {
      const ws = (await repo.workspaces.list())[0]
      const active = await repo.settings.get<string | null>('activeWorkspaceId', ws?.id ?? null)
      const existing = (await repo.chats.list({ friendId: t.friendId })).find((c) => c.workspaceId === active)
      const chatId = existing?.id ?? (active ? (await repo.chats.create({ workspaceId: active, friendId: t.friendId })).id : null)
      if (chatId) openChatWindow(chatId)
    }
    openContactsWindow()
  })
  ipcMain.handle('chat:nudge', async (e, chatId: string) => {
    const sent = await chat.nudge(chatId)
    if (sent) shakeWindow(BrowserWindow.fromWebContents(e.sender))
    return sent
  })
  ipcMain.handle('window:is-focused', (e) => BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? false)
  ipcMain.handle('chat:open-next-unread', () => openNextUnread(repo))
  ipcMain.handle('toast:open-chat', (e, chatId: string) => { openChatWindow(chatId); closeToastsFor(chatId); BrowserWindow.fromWebContents(e.sender)?.close() })
  ipcMain.handle('toast:dismiss', (e) => { BrowserWindow.fromWebContents(e.sender)?.close() })
  ipcMain.handle('chat:interrupt', (_e, chatId: string) => chat.interrupt(chatId))
  ipcMain.handle('chat:respond', (_e, chatId: string, reqId: string, answer: string, reason?: string) => chat.respond(chatId, reqId, answer, reason))
  ipcMain.handle('window:open-chat', (_e, chatId: string) => { openChatWindow(chatId) })
  ipcMain.handle('window:open-add-friend', () => { openAddFriendWindow() })
  ipcMain.handle('friends:detect', () => detectPresets())
  ipcMain.handle('friends:availability', async () => availability(await repo.friends.list()))
  ipcMain.handle('friends:add-preset', async (_e, id: string) => { const f = await addPreset(repo, id); broadcastChanged('friends'); return f })
  ipcMain.handle('friends:add-custom', async (_e, c) => { const f = await addCustom(repo, c); broadcastChanged('friends'); return f })
  ipcMain.handle('friends:test-acp', (_e, command: string, args: string[]) => testAcp(command, args))
  installMenu()
  app.on('before-quit', () => db.close())
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  openContactsWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openContactsWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
