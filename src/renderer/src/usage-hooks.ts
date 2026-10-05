import { useEffect, useState } from 'react'
import type { UsageOverview, UsageTotals } from '@shared/usage'

/** The usage overview, refetched when main says usage changed and once a minute (so "resets in 3h" keeps ticking). */
export function useUsage(range: 'today' | 'week' | 'month' | 'all' = 'week'): UsageOverview | null {
  const [o, setO] = useState<UsageOverview | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void window.asi.usage.overview(range).then((v) => { if (live) setO(v) }).catch(() => {})
    load()
    const off = window.asi.onChanged((topic) => { if (topic === 'usage' || topic === 'settings') load() }) // plan limits are stored as settings
    const tick = setInterval(load, 60_000)
    return () => { live = false; off(); clearInterval(tick) }
  }, [range])
  return o
}

export function useChatUsage(chatId: string): UsageTotals | null {
  const [t, setT] = useState<UsageTotals | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void window.asi.usage.forChat(chatId).then((v) => { if (live) setT(v) }).catch(() => {})
    load()
    const off = window.asi.onChanged((topic) => { if (topic === 'usage') load() })
    return () => { live = false; off() }
  }, [chatId])
  return t
}
