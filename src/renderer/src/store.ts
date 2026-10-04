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
  refresh(): Promise<void>
  setProfile(patch: Partial<Profile>): Promise<void>
}

const DEFAULT_PROFILE: Profile = { name: 'You', personalMessage: '', presence: 'online' }

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  workspaces: [],
  friends: [],
  chats: [],
  profile: DEFAULT_PROFILE,
  async refresh() {
    const api = window.asi.api
    const [workspaces, friends, chats, profile] = await Promise.all([
      api.workspaces.list(),
      api.friends.list(),
      api.chats.list(),
      api.settings.get<Profile>('profile', DEFAULT_PROFILE)
    ])
    set({ workspaces, friends, chats, profile, loaded: true })
  },
  async setProfile(patch) {
    const next = { ...get().profile, ...patch }
    set({ profile: next })
    await window.asi.api.settings.set('profile', next)
  }
}))

/** Keep the store fresh: initial load plus a refetch whenever main reports a change. */
export function startDataSync(): () => void {
  void useData.getState().refresh()
  return window.asi.onChanged(() => void useData.getState().refresh())
}
