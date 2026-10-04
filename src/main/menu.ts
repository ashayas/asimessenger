import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '@shared/app'

/**
 * Menu bar. Shortcuts that act on app data (⌘1-9, ⌘K, ...) are handled by the renderer's key listener
 * (so they work in every window and are testable); the menu only displays them (registerAccelerator: false).
 */
export function installMenu(): void {
  const hint = (label: string, accelerator: string): MenuItemConstructorOptions => ({ label, accelerator, registerAccelerator: false, enabled: true, click: () => {} })
  const workspaces: MenuItemConstructorOptions[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => hint(`Workspace ${n}`, `CmdOrCtrl+${n}`))

  const template: MenuItemConstructorOptions[] = [
    { label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, hint('Options…', 'CmdOrCtrl+,'), { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [hint('Search Everything…', 'CmdOrCtrl+K'), hint('New Chat', 'CmdOrCtrl+N'), hint('Doodle (Excalidraw)', 'CmdOrCtrl+Shift+D'), hint('Add a Friend…', 'CmdOrCtrl+Shift+N'), { type: 'separator' }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Workspaces', submenu: workspaces },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  void app
}
