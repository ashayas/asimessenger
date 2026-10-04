import { contextBridge, ipcRenderer } from 'electron'
import { REPO_CHANNEL_PREFIX, REPO_METHODS } from '../shared/api'

const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
for (const [group, methods] of Object.entries(REPO_METHODS)) {
  api[group] = {}
  for (const m of methods) {
    api[group]![m] = (...args) => ipcRenderer.invoke(`${REPO_CHANNEL_PREFIX}${group}.${m}`, ...args)
  }
}

contextBridge.exposeInMainWorld('asi', { platform: process.platform, api })
