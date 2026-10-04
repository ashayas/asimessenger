import { ipcMain } from 'electron'
import type { Repo } from './db/repo'
import { REPO_CHANNEL_PREFIX } from '@shared/api'

/** Registers one IPC handler per repo method: "repo:<group>.<method>". */
export function registerRepoIpc(repo: Repo): string[] {
  const channels: string[] = []
  for (const [group, methods] of Object.entries(repo)) {
    for (const [name, fn] of Object.entries(methods as Record<string, unknown>)) {
      if (typeof fn !== 'function') continue
      const channel = `${REPO_CHANNEL_PREFIX}${group}.${name}`
      ipcMain.handle(channel, (_e, ...args: unknown[]) =>
        (fn as (...a: unknown[]) => unknown).apply(methods, args)
      )
      channels.push(channel)
    }
  }
  return channels
}
