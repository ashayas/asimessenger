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

const chat = {
  send: (chatId: string, text: string, quote?: { name: string; text: string }): Promise<unknown> => ipcRenderer.invoke('chat:send', chatId, text, quote),
  setMode: (chatId: string, mode: string): Promise<void> => ipcRenderer.invoke('chat:set-mode', chatId, mode),
  nudge: (chatId: string): Promise<boolean> => ipcRenderer.invoke('chat:nudge', chatId),
  interrupt: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:interrupt', chatId),
  respond: (chatId: string, reqId: string, answer: string, reason?: string): Promise<void> => ipcRenderer.invoke('chat:respond', chatId, reqId, answer, reason),
  openWindow: (chatId: string): Promise<void> => ipcRenderer.invoke('window:open-chat', chatId)
}

const friends = {
  detect: (): Promise<unknown> => ipcRenderer.invoke('friends:detect'),
  availability: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('friends:availability'),
  addPreset: (id: string): Promise<unknown> => ipcRenderer.invoke('friends:add-preset', id),
  addCustom: (c: { name: string; command: string; args: string[]; kind: 'acp' | 'pty' }): Promise<unknown> => ipcRenderer.invoke('friends:add-custom', c),
  testAcp: (command: string, args: string[]): Promise<unknown> => ipcRenderer.invoke('friends:test-acp', command, args),
  openAddWindow: (): Promise<void> => ipcRenderer.invoke('window:open-add-friend')
}

const safety = {
  setGlobalDangerous: (on: boolean): Promise<void> => ipcRenderer.invoke('safety:set-global-dangerous', on),
  setFriendDangerous: (id: string, on: boolean): Promise<void> => ipcRenderer.invoke('safety:set-friend-dangerous', id, on),
  openOptions: (): Promise<void> => ipcRenderer.invoke('window:open-options')
}

contextBridge.exposeInMainWorld('asi', { platform: process.platform, api, onChanged, pickFolder, chat, friends, safety })
