import { useEffect } from 'react'
import { useData } from './store'

/** Global key handling for the renderer window. ⌘1-9 jumps to the workspace in that slot. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const { activeWorkspaceId } = useData.getState()
        if (activeWorkspaceId) void window.asi.doodle.open(activeWorkspaceId)
        return
      }
      if (!e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        void window.asi.search.openPalette()
        return
      }
      if (e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        void window.asi.chat.openNextUnread()
        return
      }
      if (e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void window.asi.friends.openAddWindow()
        return
      }
      if (e.shiftKey) return
      if (e.key === ',') {
        e.preventDefault()
        void window.asi.safety.openOptions()
        return
      }
      if (/^[1-9]$/.test(e.key)) {
        const { workspaces, setActiveWorkspace } = useData.getState()
        const ws = workspaces.find((w) => w.slot === Number(e.key))
        if (ws) {
          e.preventDefault()
          void setActiveWorkspace(ws.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
