import { useEffect, useState } from 'react'
import { ContactList } from './ContactList'
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
  if (route === '/' || route === '/contacts') return <ContactList />
  return <h1>ASI Messenger</h1>
}
