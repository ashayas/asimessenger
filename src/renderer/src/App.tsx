import { useEffect, useState } from 'react'
import { Gallery } from './Gallery'
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
  if (route === '/gallery') return <Gallery />
  return <h1>ASI Messenger</h1>
}
