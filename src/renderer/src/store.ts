import { create } from 'zustand'
import type { Chat, Friend, Label, Workspace } from '@shared/models'
import type { Presence } from '@shared/status'

export interface Profile {
  name: string
  personalMessage: string
  presence: Presence
}

interface DataState {
  loaded: boolean
  workspaces: Workspace[]
  friends: Friend[]
  chats: Chat[]
  profile: Profile
  activeWorkspaceId: string | null
  availability: Record<string, boolean>
  labels: Label[]
  friendLabels: Record<string, string[]>
  chatLabels: Record<string, string[]>
  refresh(): Promise<void>
  setProfile(patch: Partial<Profile>): Promise<void>
  setActiveWorkspace(id: string): Promise<void>
  addWorkspaceFromFolder(): Promise<void>
  /** Open the most recent chat with this friend in the active workspace (creating one if none), in its own window. */
  openFriend(friendId: string): Promise<void>
  newChatWith(friendId: string): Promise<void>
  /** A new chat in its own git worktree. Rejects with a readable message when the workspace is not a usable repo. */
  newIsolatedChatWith(friendId: string): Promise<void>
  openChat(chatId: string): Promise<void>
}

const DEFAULT_PROFILE: Profile = { name: 'You', personalMessage: '', presence: 'online' }

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  workspaces: [],
  friends: [],
  chats: [],
  profile: DEFAULT_PROFILE,
  activeWorkspaceId: null,
  availability: {},
  labels: [],
  friendLabels: {},
  chatLabels: {},
  async refresh() {
    const api = window.asi.api
    const [workspaces, friends, chats, profile, stored, availability, labels, assigned] = await Promise.all([
      api.workspaces.list(),
      api.friends.list(),
      api.chats.list(),
      api.settings.get<Profile>('profile', DEFAULT_PROFILE),
      api.settings.get<string | null>('activeWorkspaceId', null),
      window.asi.friends.availability(),
      api.labels.list(),
      api.labels.assignments()
    ])
    const group = (rows: { labelId: string; [k: string]: string }[], key: string) => rows.reduce<Record<string, string[]>>((m, r) => { (m[r[key]!] ??= []).push(r.labelId); return m }, {})
    const friendLabels = group(assigned.friends, 'friendId')
    const chatLabels = group(assigned.chats, 'chatId')
    const activeWorkspaceId = workspaces.some((w) => w.id === stored) ? stored : (workspaces[0]?.id ?? null)
    set({ workspaces, friends, chats, profile, activeWorkspaceId, availability, labels, friendLabels, chatLabels, loaded: true })
  },
  async setProfile(patch) {
    const next = { ...get().profile, ...patch }
    set({ profile: next })
    await window.asi.api.settings.set('profile', next)
  },
  async setActiveWorkspace(id) {
    set({ activeWorkspaceId: id })
    await window.asi.api.settings.set('activeWorkspaceId', id)
  },
  async addWorkspaceFromFolder() {
    const path = await window.asi.pickFolder()
    if (!path) return
    const name = path.split('/').filter(Boolean).pop() ?? path
    const ws = await window.asi.api.workspaces.create({ name, path })
    await get().setActiveWorkspace(ws.id)
  }
  ,
  async openFriend(friendId) {
    const { chats, activeWorkspaceId } = get()
    const existing = chats.find((c) => c.friendId === friendId && c.workspaceId === activeWorkspaceId)
    if (existing) return get().openChat(existing.id)
    return get().newChatWith(friendId)
  },
  async newChatWith(friendId) {
    const { activeWorkspaceId } = get()
    if (!activeWorkspaceId) return
    const chat = await window.asi.api.chats.create({ workspaceId: activeWorkspaceId, friendId })
    await get().openChat(chat.id)
  },
  async newIsolatedChatWith(friendId) {
    const { activeWorkspaceId } = get()
    if (!activeWorkspaceId) return
    const chat = await window.asi.chat.newIsolated(activeWorkspaceId, friendId)
    await get().openChat(chat.id)
  },
  async openChat(chatId) {
    await window.asi.chat.openWindow(chatId)
  }
}))

/** Keep the store fresh: initial load plus a refetch whenever main reports a change. */
export function startDataSync(): () => void {
  void useData.getState().refresh()
  return window.asi.onChanged(() => void useData.getState().refresh())
}
