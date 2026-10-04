import type { Chat, Friend } from './models'
import type { Presence } from './status'

/** Harnesses that need no installed CLI. */
export const isBuiltin = (h: string): boolean => h === 'asi' || h === 'echo' || h === 'fake'

export type GroupId = 'asi' | 'needs-you' | 'working' | 'online' | 'offline'

export interface ContactGroup {
  id: GroupId
  title: string
  friendIds: string[]
}

export interface FriendLive {
  presence: Presence
  /** The status line shown under the name (the "personal message"). */
  message: string | null
  unread: number
}

const ORDER: { id: GroupId; title: string }[] = [
  { id: 'asi', title: 'ASI' },
  { id: 'needs-you', title: 'Needs you' },
  { id: 'working', title: 'Working' },
  { id: 'online', title: 'Online' },
  { id: 'offline', title: 'Offline' }
]

/** Collapse a friend's chats into one live presence: waiting-on-you beats working beats idle. */
export function liveFor(friend: Friend, chats: Chat[], available: boolean): FriendLive {
  const mine = chats.filter((c) => c.friendId === friend.id)
  const unread = mine.reduce((n, c) => n + c.unreadCount, 0)
  const pick = (s: Presence) => mine.filter((c) => c.status === s).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  const away = pick('away')
  if (away) return { presence: 'away', message: away.statusText, unread }
  const busy = pick('busy')
  if (busy) return { presence: 'busy', message: busy.statusText, unread }
  if (!available) return { presence: 'offline', message: null, unread }
  const latest = [...mine].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  return { presence: 'online', message: latest?.statusText ?? null, unread }
}

export function groupFriends(
  friends: Friend[],
  chats: Chat[],
  availability: Record<string, boolean>,
  filter = ''
): { groups: ContactGroup[]; live: Record<string, FriendLive> } {
  const q = filter.trim().toLowerCase()
  const live: Record<string, FriendLive> = {}
  const buckets: Record<GroupId, Friend[]> = { asi: [], 'needs-you': [], working: [], online: [], offline: [] }

  for (const f of friends) {
    if (q && !f.displayName.toLowerCase().includes(q)) continue
    const l = liveFor(f, chats, availability[f.id] ?? isBuiltin(f.harness))
    live[f.id] = l
    if (f.harness === 'asi') buckets.asi.push(f)
    else if (l.presence === 'away') buckets['needs-you'].push(f)
    else if (l.presence === 'busy') buckets.working.push(f)
    else if (l.presence === 'online') buckets.online.push(f)
    else buckets.offline.push(f)
  }

  const groups = ORDER.map(({ id, title }) => ({
    id,
    title,
    friendIds: buckets[id].sort((a, b) => a.displayName.localeCompare(b.displayName)).map((f) => f.id)
  })).filter((g) => g.friendIds.length > 0)
  return { groups, live }
}
