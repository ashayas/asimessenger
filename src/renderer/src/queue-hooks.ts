import { useEffect, useState } from 'react'

export interface QueuedPrompt { text: string; held: boolean }

/** The follow-up held for this chat, if any. Refetches when main reports the queue changed. */
export function useQueued(chatId: string): QueuedPrompt | null {
  const [q, setQ] = useState<QueuedPrompt | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void window.asi.chat.queued(chatId).then((v) => { if (live) setQ(v) }).catch(() => {})
    load()
    const off = window.asi.onChanged((topic) => { if (topic === 'queue') load() })
    return () => { live = false; off() }
  }, [chatId])
  return q
}
