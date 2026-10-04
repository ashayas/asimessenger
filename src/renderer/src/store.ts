import { create } from 'zustand'
import type { Chat, Friend, Workspace } from '@shared/models'
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
  refresh(): Promise<void>
  setProfile(patch: Partial<Profile>): Promise<void>
  setActiveWorkspace(id: string): Promise<void>
  addWorkspaceFromFolder(): Promise<void>
}

const DEFAULT_PROFILE: Profile = { name: 'You', personalMessage: '', presence: 'online' }

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  workspaces: [],
  friends: [],
  chats: [],
  profile: DEFAULT_PROFILE,
  activeWorkspaceId: null,
  async refresh() {
    const api = window.asi.api
    const [workspaces, friends, chats, profile, stored] = await Promise.all([
      api.workspaces.list(),
      api.friends.list(),
      api.chats.list(),
      api.settings.get<Profile>('profile', DEFAULT_PROFILE),
      api.settings.get<string | null>('activeWorkspaceId', null)
    ])
    const activeWorkspaceId = workspaces.some((w) => w.id === stored) ? stored : (workspaces[0]?.id ?? null)
    set({ workspaces, friends, chats, profile, activeWorkspaceId, loaded: true })
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
}))

/** Keep the store fresh: initial load plus a refetch whenever main reports a change. */
export function startDataSync(): () => void {
  void useData.getState().refresh()
  return window.asi.onChanged(() => void useData.getState().refresh())
}
