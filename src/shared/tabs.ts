export interface TabsState {
  open: string[]
  active: string | null
}

export const EMPTY_TABS: TabsState = { open: [], active: null }

/** Open (or focus) a chat's tab. New tabs go next to the active one so related chats stay together. */
export function openTab(s: TabsState, id: string): TabsState {
  if (s.open.includes(id)) return { ...s, active: id }
  const at = s.active ? s.open.indexOf(s.active) + 1 : s.open.length
  return { open: [...s.open.slice(0, at), id, ...s.open.slice(at)], active: id }
}

/** Close a tab; focus moves to the tab that slid into its place (or the previous one). */
export function closeTab(s: TabsState, id: string): TabsState {
  const i = s.open.indexOf(id)
  if (i < 0) return s
  const open = s.open.filter((x) => x !== id)
  return { open, active: s.active === id ? (open[Math.min(i, open.length - 1)] ?? null) : s.active }
}

export function cycleTab(s: TabsState, dir: 1 | -1): TabsState {
  if (s.open.length < 2 || !s.active) return s
  const i = s.open.indexOf(s.active)
  return { ...s, active: s.open[(i + dir + s.open.length) % s.open.length]! }
}

/** Drop tabs whose chats no longer exist (deleted, or "delete all chats"). */
export function pruneTabs(s: TabsState, exists: (id: string) => boolean): TabsState {
  const open = s.open.filter(exists)
  return { open, active: s.active && open.includes(s.active) ? s.active : (open[0] ?? null) }
}
