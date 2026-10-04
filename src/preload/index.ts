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
  openNextUnread: (): Promise<string | null> => ipcRenderer.invoke('chat:open-next-unread'),
  toastOpenChat: (chatId: string): Promise<void> => ipcRenderer.invoke('toast:open-chat', chatId),
  toastDismiss: (): Promise<void> => ipcRenderer.invoke('toast:dismiss'),
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

const windowFocused = (): Promise<boolean> => ipcRenderer.invoke('window:is-focused')

const attachments = {
  load: (messageId: string): Promise<unknown> => ipcRenderer.invoke('attachments:load', messageId),
  open: (messageId: string): Promise<void> => ipcRenderer.invoke('attachments:open', messageId),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pick-files'),
  sendFiles: (chatId: string, paths: string[], note?: string): Promise<void> => ipcRenderer.invoke('chat:send-files', chatId, paths, note)
}

const search = {
  all: (q: string): Promise<unknown> => ipcRenderer.invoke('search:all', q),
  jump: (t: unknown): Promise<void> => ipcRenderer.invoke('search:jump', t),
  openPalette: (): Promise<void> => ipcRenderer.invoke('window:open-search'),
  onFocus: (cb: () => void): (() => void) => { const h = () => cb(); ipcRenderer.on('asi:search-focus', h); return () => ipcRenderer.removeListener('asi:search-focus', h) }
}

const doodle = {
  open: (workspaceId: string, opts?: { chatId?: string; name?: string }): Promise<void> => ipcRenderer.invoke('doodle:open', workspaceId, opts),
  list: (wsId: string): Promise<{ name: string; updatedAt: number }[]> => ipcRenderer.invoke('doodle:list', wsId),
  newName: (wsId: string): Promise<string> => ipcRenderer.invoke('doodle:new-name', wsId),
  load: (wsId: string, name: string): Promise<string | null> => ipcRenderer.invoke('doodle:load', wsId, name),
  save: (wsId: string, name: string, json: string): Promise<void> => ipcRenderer.invoke('doodle:save', wsId, name, json),
  send: (wsId: string, chatId: string, name: string, pngBase64: string, note?: string): Promise<void> => ipcRenderer.invoke('doodle:send', wsId, chatId, name, pngBase64, note),
  reveal: (wsId: string): Promise<void> => ipcRenderer.invoke('doodle:reveal', wsId),
  onOpen: (cb: (a: { chatId: string | null; name: string | null }) => void): (() => void) => { const h = (_e: unknown, a: { chatId: string | null; name: string | null }) => cb(a); ipcRenderer.on('asi:doodle-open', h); return () => ipcRenderer.removeListener('asi:doodle-open', h) }
}

const pty = {
  attach: (chatId: string): Promise<string> => ipcRenderer.invoke('pty:attach', chatId),
  input: (chatId: string, data: string): Promise<void> => ipcRenderer.invoke('pty:input', chatId, data),
  resize: (chatId: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('pty:resize', chatId, cols, rows),
  openExternal: (chatId: string): Promise<boolean> => ipcRenderer.invoke('terminal:open-external', chatId),
  onData: (cb: (chatId: string, data: string) => void): (() => void) => { const h = (_e: unknown, c: string, d: string) => cb(c, d); ipcRenderer.on('asi:pty-data', h); return () => ipcRenderer.removeListener('asi:pty-data', h) }
}

const browser = {
  open: (url: string): Promise<void> => ipcRenderer.invoke('browser:open', url),
  state: (): Promise<unknown> => ipcRenderer.invoke('browser:state'),
  newTab: (): Promise<void> => ipcRenderer.invoke('browser:new-tab'),
  closeTab: (id: number): Promise<void> => ipcRenderer.invoke('browser:close-tab', id),
  select: (id: number): Promise<void> => ipcRenderer.invoke('browser:select', id),
  navigate: (input: string): Promise<void> => ipcRenderer.invoke('browser:navigate', input),
  back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('browser:open-external', url),
  onState: (cb: (s: unknown) => void): (() => void) => { const h = (_e: unknown, s: unknown) => cb(s); ipcRenderer.on('asi:browser-state', h); return () => ipcRenderer.removeListener('asi:browser-state', h) }
}

const onboarding = {
  complete: (input: { name: string; workspacePath: string; presetIds: string[] }): Promise<void> => ipcRenderer.invoke('onboarding:complete', input),
  micStatus: (): Promise<string> => ipcRenderer.invoke('permissions:mic-status'),
  askMic: (): Promise<string> => ipcRenderer.invoke('permissions:ask-mic')
}

const voice = {
  transcribe: (wav: Uint8Array): Promise<{ text: string; engine: string; seconds: number }> => ipcRenderer.invoke('voice:transcribe', wav),
  overview: (): Promise<unknown> => ipcRenderer.invoke('voice:overview'),
  install: (modelId: string): Promise<void> => ipcRenderer.invoke('voice:install', modelId),
  cancel: (modelId: string): Promise<void> => ipcRenderer.invoke('voice:cancel', modelId),
  remove: (modelId: string): Promise<void> => ipcRenderer.invoke('voice:remove', modelId),
  select: (id: string | null): Promise<void> => ipcRenderer.invoke('voice:select', id),
  onProgress: (cb: (p: unknown) => void): (() => void) => { const h = (_e: unknown, p: unknown) => cb(p); ipcRenderer.on('asi:voice-progress', h); return () => ipcRenderer.removeListener('asi:voice-progress', h) },
  testMode: (): Promise<boolean> => ipcRenderer.invoke('voice:test-mode'),
  status: (): Promise<{ engines: { id: string; name: string; available: boolean }[]; selected: string | null }> => ipcRenderer.invoke('voice:status')
}

const brain = {
  status: (): Promise<{ connected: boolean; model?: string; accountId?: string }> => ipcRenderer.invoke('asi:brain-status'),
  connect: (input: { accountId: string; token: string; model: string }): Promise<{ latencyMs: number; costPerDecisionUsd: number }> => ipcRenderer.invoke('asi:brain-connect', input),
  disconnect: (): Promise<void> => ipcRenderer.invoke('asi:brain-disconnect')
}

contextBridge.exposeInMainWorld('asi', { brain, voice, onboarding, browser, pty, doodle, search, attachments, platform: process.platform, windowFocused, api, onChanged, pickFolder, chat, friends, safety })
