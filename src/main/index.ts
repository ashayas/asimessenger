import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/app'
import { openDb } from './db/db'
import { createRepo } from './db/repo'
import { registerRepoIpc } from './ipc'
import { ensureDefaults } from './defaults'
import { installMenu } from './menu'

app.setName(APP_NAME)
if (process.env['ASI_USER_DATA']) app.setPath('userData', process.env['ASI_USER_DATA'])

const iconPath = join(import.meta.dirname, '../../build/icon.png')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 330,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 8 },
    height: 720,
    title: APP_NAME,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}

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
  installMenu()
  app.on('before-quit', () => db.close())
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
