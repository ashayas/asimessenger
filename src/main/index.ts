import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/app'
import { openDb } from './db/db'
import { createRepo } from './db/repo'
import { broadcastChanged, registerRepoIpc } from './ipc'
import { HarnessManager } from '../harness/manager'
import { registerHarnesses } from '../harness/registry'
import { createIngestor } from './ingest'
import { openChatWindow, openContactsWindow } from './windows'
import { createChatService } from './chat-service'
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
  const ingestor = createIngestor(repo, broadcastChanged)
  const manager = new HarnessManager({
    onEvent: (chatId, e) => void ingestor.ingest(chatId, e),
    onResumeId: (chatId, id) => void repo.chats.setSession(chatId, id)
  })
  registerHarnesses(manager)
  app.on('will-quit', () => void manager.disposeAll())
  const chat = createChatService({ repo, manager, ingestor, notify: broadcastChanged })
  ipcMain.handle('chat:send', (_e, chatId: string, text: string, quote?: { name: string; text: string }) => chat.send(chatId, text, quote))
  ipcMain.handle('chat:interrupt', (_e, chatId: string) => chat.interrupt(chatId))
  ipcMain.handle('chat:respond', (_e, chatId: string, reqId: string, answer: string, reason?: string) => chat.respond(chatId, reqId, answer, reason))
  ipcMain.handle('window:open-chat', (_e, chatId: string) => { openChatWindow(chatId) })
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
