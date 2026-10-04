import { contextBridge, ipcRenderer } from 'electron'
import { CHANGED_CHANNEL, REPO_CHANNEL_PREFIX, REPO_METHODS } from '../shared/api'

const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
for (const [group, methods] of Object.entries(REPO_METHODS)) {
  api[group] = {}
  for (const m of methods) {
    api[group]![m] = (...args) => ipcRenderer.invoke(`${REPO_CHANNEL_PREFIX}${group}.${m}`, ...args)
  }
}

function onChanged(cb: (topic: string) => void): () => void {
  const handler = (_e: unknown, topic: string) => cb(topic)
  ipcRenderer.on(CHANGED_CHANNEL, handler)
  return () => ipcRenderer.removeListener(CHANGED_CHANNEL, handler)
}

const pickFolder = (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder')

contextBridge.exposeInMainWorld('asi', { platform: process.platform, api, onChanged, pickFolder })
