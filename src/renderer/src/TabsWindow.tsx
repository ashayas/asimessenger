import { useCallback, useEffect, useRef, useState } from 'react'
import { closeTab, cycleTab, EMPTY_TABS, openTab, pruneTabs, type TabsState } from '@shared/tabs'
import { avatarFor } from '@shared/harness-meta'
import { StatusDot, WindowFrame } from './ui/kit'
import { ChatWindow } from './ChatWindow'
import { LabelChips } from './LabelEditor'
import { useData } from './store'

/** One window per workspace, with a tab per chat. Pop a tab out to give it its own window. */
export function TabsWindow({ workspaceId, firstChat }: { workspaceId: string; firstChat: string | null }) {
  const { chats, friends, workspaces, chatLabels, loaded } = useData()
  const [tabs, setTabs] = useState<TabsState>(EMPTY_TABS)
  const [ready, setReady] = useState(false)
  const [picking, setPicking] = useState(false)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const key = `tabs:${workspaceId}`
  const ws = workspaces.find((w) => w.id === workspaceId)

  // restore the tabs you had open, then make sure the requested chat is one of them
  useEffect(() => {
    void window.asi.api.settings.get<TabsState>(key, EMPTY_TABS).then(async (saved) => {
      // chats opened while this window was loading arrive here, in the order they were opened
      const queued = await window.asi.tabs.takePending(workspaceId)
      const base = firstChat ? openTab(saved, firstChat) : saved
      setTabs(queued.reduce(openTab, base))
      setReady(true)
    })
  }, [key, firstChat, workspaceId])
  useEffect(() => window.asi.tabs.onOpen(({ chatId }) => setTabs((t) => openTab(t, chatId))), [])

  useEffect(() => {
    if (!ready) return
    void window.asi.api.settings.set(key, tabs)
    void window.asi.tabs.setActive(workspaceId, tabs.active)
  }, [tabs, ready, key, workspaceId])

  // forget chats that were deleted
  useEffect(() => {
    if (ready && loaded) setTabs((t) => pruneTabs(t, (id) => chats.some((c) => c.id === id)))
  }, [chats, ready, loaded])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
      if (e.key === '}' || e.key === ']') { e.preventDefault(); setTabs((t) => cycleTab(t, 1)) }
      else if (e.key === '{' || e.key === '[') { e.preventDefault(); setTabs((t) => cycleTab(t, -1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeChat = chats.find((c) => c.id === tabs.active)
  useEffect(() => { document.title = `${ws?.name ?? 'Chats'} · ${tabs.open.length} chat${tabs.open.length === 1 ? '' : 's'}` }, [ws?.name, tabs.open.length])

  const popOut = useCallback((id: string) => { setTabs((t) => closeTab(t, id)); void window.asi.tabs.popOut(id) }, [])
  const newChat = async (friendId: string) => {
    setPicking(false)
    const c = await window.asi.api.chats.create({ workspaceId, friendId })
    setTabs((t) => openTab(t, c.id))
  }

  return (
    <WindowFrame title={`${ws?.name ?? 'Chats'} · ${tabs.open.length} chats`} danger={activeChat?.mode === 'dangerous'}>
      <div className="ttabs" role="tablist" aria-label="Open chats">
        {tabs.open.map((id) => {
          const c = chats.find((x) => x.id === id)
          if (!c) return null
          const f = friends.find((x) => x.id === c.friendId)
          return (
            <div key={id} role="tab" aria-selected={id === tabs.active} data-chat={c.title} className={`ttab${id === tabs.active ? ' sel' : ''}`} onClick={() => setTabs((t) => openTab(t, id))}>
              <StatusDot presence={c.status} />
              <span className="tt">{c.mode === 'dangerous' ? '⚠ ' : ''}{c.title}</span>
              {f ? <span className="ttf">{avatarFor(f).label}</span> : null}
              <LabelChips ids={chatLabels[id] ?? []} />
              {c.unreadCount > 0 && id !== tabs.active ? <span className="badge">{c.unreadCount}</span> : null}
              <button aria-label={`Pop out ${c.title}`} title="Open in its own window" onClick={(e) => { e.stopPropagation(); popOut(id) }}>↗</button>
              <button aria-label={`Close ${c.title}`} onClick={(e) => { e.stopPropagation(); setTabs((t) => closeTab(t, id)) }}>×</button>
            </div>
          )
        })}
        <div className="tnew">
          <button aria-label="New chat" onClick={() => setPicking((p) => !p)}>＋</button>
          {picking ? (
            <div className="tmenu" role="menu">
              {friends.map((f) => <button key={f.id} role="menuitem" onClick={() => void newChat(f.id)}>{f.displayName}</button>)}
            </div>
          ) : null}
        </div>
      </div>
      {tabs.active ? <ChatWindow key={tabs.active} chatId={tabs.active} embedded /> : <div className="empty">No chats open. Press ＋ to start one.</div>}
    </WindowFrame>
  )
}
