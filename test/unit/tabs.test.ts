import { expect, test } from 'vitest'
import { closeTab, cycleTab, EMPTY_TABS, openTab, pruneTabs, type TabsState } from '../../src/shared/tabs'

const s = (open: string[], active: string | null): TabsState => ({ open, active })

test('opening adds next to the active tab and re-opening just focuses', () => {
  let t = openTab(EMPTY_TABS, 'a')
  t = openTab(t, 'b')
  t = openTab(t, 'c')
  expect(t).toEqual(s(['a', 'b', 'c'], 'c'))
  t = openTab(s(['a', 'b', 'c'], 'a'), 'x')
  expect(t).toEqual(s(['a', 'x', 'b', 'c'], 'x'))
  expect(openTab(t, 'c')).toEqual(s(['a', 'x', 'b', 'c'], 'c'))
})

test('closing focuses the neighbor; closing a background tab keeps focus; closing the last empties', () => {
  expect(closeTab(s(['a', 'b', 'c'], 'b'), 'b')).toEqual(s(['a', 'c'], 'c'))
  expect(closeTab(s(['a', 'b', 'c'], 'c'), 'c')).toEqual(s(['a', 'b'], 'b'))
  expect(closeTab(s(['a', 'b', 'c'], 'c'), 'a')).toEqual(s(['b', 'c'], 'c'))
  expect(closeTab(s(['a'], 'a'), 'a')).toEqual(s([], null))
  expect(closeTab(s(['a'], 'a'), 'zzz')).toEqual(s(['a'], 'a'))
})

test('cycling wraps both ways and is a no-op with one tab', () => {
  expect(cycleTab(s(['a', 'b', 'c'], 'c'), 1).active).toBe('a')
  expect(cycleTab(s(['a', 'b', 'c'], 'a'), -1).active).toBe('c')
  expect(cycleTab(s(['a'], 'a'), 1)).toEqual(s(['a'], 'a'))
})

test('pruning drops deleted chats and repairs the active tab', () => {
  expect(pruneTabs(s(['a', 'b', 'c'], 'b'), (id) => id !== 'b')).toEqual(s(['a', 'c'], 'a'))
  expect(pruneTabs(s(['a'], 'a'), () => false)).toEqual(s([], null))
})
