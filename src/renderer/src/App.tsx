import { lazy, Suspense, useEffect, useState } from 'react'
import { AddFriend } from './AddFriend'
import { AttachmentViewer } from './AttachmentViewer'
import { ChatWindow } from './ChatWindow'
import { ContactList } from './ContactList'
import { Browser } from './Browser'
import { Options } from './Options'
import { Palette } from './Palette'
import { Toast } from './Toast'
import { TabsWindow } from './TabsWindow'
import { Welcome } from './Welcome'
import { Gallery } from './Gallery'
import { startDataSync } from './store'
import { useGlobalShortcuts } from './shortcuts'
import './styles/ui.css'

// Excalidraw is big; only the doodle window pays for it.
const Doodle = lazy(() => import('./Doodle'))

function useRoute(): string {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, '') || '/')
  useEffect(() => {
    const on = () => setRoute(location.hash.replace(/^#/, '') || '/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  useEffect(() => startDataSync(), [])
  useGlobalShortcuts()
  if (route === '/gallery') return <Gallery />
  if (route === '/add-friend') return <AddFriend />
  if (route === '/options') return <Options />
  if (route === '/welcome') return <Welcome />
  if (route === '/browser') return <Browser />
  if (route === '/search') return <Palette />
  if (route.startsWith('/toast')) return <Toast />
  const doodle = /^\/doodle\/([^?]+)/.exec(route)
  if (doodle) {
    const q = new URLSearchParams(route.split('?')[1] ?? '')
    return <Suspense fallback={null}><Doodle workspaceId={doodle[1]!} chatId={q.get('chat')} name={q.get('name')} /></Suspense>
  }
  const tabsRoute = /^\/tabs\/([^?]+)/.exec(route)
  if (tabsRoute) return <TabsWindow workspaceId={tabsRoute[1]!} firstChat={new URLSearchParams(route.split('?')[1] ?? '').get('chat')} />
  const att = /^\/attachment\/(.+)$/.exec(route)
  if (att) return <AttachmentViewer messageId={att[1]!} />
  const chat = /^\/chat\/(.+)$/.exec(route)
  if (chat) return <ChatWindow chatId={chat[1]!} />
  if (route === '/' || route === '/contacts') return <ContactList />
  return <h1>ASI Messenger</h1>
}
