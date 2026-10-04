import { BrowserWindow, ipcMain } from 'electron'
import type { Repo } from './db/repo'
import { CHANGED_CHANNEL, REPO_CHANNEL_PREFIX } from '@shared/api'

const READ_ONLY = new Set(['list', 'get', 'query', 'forChat', 'forFriend', 'assignments'])

/** Tells every window that data in `topic` changed so stores can refetch. */
const listeners = new Set<(topic: string) => void>()
/** Main-process code that wants to react to data changes (dock badge, ...). */
export function onChanged(fn: (topic: string) => void): void {
  listeners.add(fn)
}

export function broadcastChanged(topic: string): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CHANGED_CHANNEL, topic)
  for (const fn of listeners) fn(topic)
}

/** Registers one IPC handler per repo method: "repo:<group>.<method>". */
export function registerRepoIpc(repo: Repo): string[] {
  const channels: string[] = []
  for (const [group, methods] of Object.entries(repo)) {
    for (const [name, fn] of Object.entries(methods as Record<string, unknown>)) {
      if (typeof fn !== 'function') continue
      const channel = `${REPO_CHANNEL_PREFIX}${group}.${name}`
      const readOnly = READ_ONLY.has(name)
      ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
        const result = await (fn as (...a: unknown[]) => unknown).apply(methods, args)
        if (!readOnly) broadcastChanged(group)
        return result
      })
      channels.push(channel)
    }
  }
  return channels
}
