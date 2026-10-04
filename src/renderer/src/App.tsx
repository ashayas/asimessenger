import { useEffect, useState } from 'react'
import { AddFriend } from './AddFriend'
import { ChatWindow } from './ChatWindow'
import { ContactList } from './ContactList'
import { Options } from './Options'
import { Gallery } from './Gallery'
import { startDataSync } from './store'
import { useGlobalShortcuts } from './shortcuts'
import './styles/ui.css'

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
  const chat = /^\/chat\/(.+)$/.exec(route)
  if (chat) return <ChatWindow chatId={chat[1]!} />
  if (route === '/' || route === '/contacts') return <ContactList />
  return <h1>ASI Messenger</h1>
}
