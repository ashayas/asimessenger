import { expect, test } from 'vitest'
import { groupFriends } from '../../src/shared/grouping'
import type { Chat, Friend } from '../../src/shared/models'

const friend = (id: string, name: string, harness: Friend['harness'] = 'claude'): Friend => ({
  id, harness, displayName: name, avatar: null, command: null, args: [], transport: null, defaultMode: 'ask',
  dangerousAllowed: false, letteringStyle: 'funky', secretRef: null, createdAt: 0
})
const chat = (id: string, friendId: string, status: Chat['status'], statusText: string | null = null, unread = 0): Chat => ({
  id, workspaceId: 'w', friendId, title: id, harnessSessionId: null, status, statusText, mode: 'ask', unreadCount: unread, createdAt: 0, lastActivityAt: 1
})

test('groups by what each agent is doing; waiting beats working beats idle', () => {
  const friends = [friend('a', 'ASI', 'asi'), friend('c', 'Claude'), friend('x', 'Codex'), friend('g', 'Gemini'), friend('p', 'Pi')]
  const chats = [
    chat('1', 'c', 'busy', 'running tests'),
    chat('2', 'c', 'away', 'waiting on u', 2),
    chat('3', 'x', 'busy', 'editing'),
    chat('4', 'g', 'online')
  ]
  const { groups, live } = groupFriends(friends, chats, { c: true, x: true, g: true, p: false })
  expect(groups.map((g) => [g.id, g.friendIds])).toEqual([
    ['asi', ['a']],
    ['needs-you', ['c']],
    ['working', ['x']],
    ['online', ['g']],
    ['offline', ['p']]
  ])
  expect(live['c']).toEqual({ presence: 'away', message: 'waiting on u', unread: 2 })
})

test('empty groups are omitted and the filter matches names', () => {
  const friends = [friend('c', 'Claude'), friend('x', 'Codex')]
  const { groups } = groupFriends(friends, [], { c: true, x: true }, 'cod')
  expect(groups).toEqual([{ id: 'online', title: 'Online', friendIds: ['x'] }])
})

test('a friend with no available CLI is offline unless a chat is active', () => {
  const { groups } = groupFriends([friend('p', 'Pi')], [], { p: false })
  expect(groups[0]!.id).toBe('offline')
})
