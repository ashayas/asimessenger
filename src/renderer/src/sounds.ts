import nudge from '../../../assets/sounds/nudge.wav?url'
import message from '../../../assets/sounds/message.wav?url'
import signin from '../../../assets/sounds/signin.wav?url'

const URLS = { nudge, message, signin } as const
export type SoundName = keyof typeof URLS

/** Play a bundled sound. Fails silently (autoplay policy, missing device). Tests can count plays via window.__sounds. */
export function play(name: SoundName): void {
  const w = window as unknown as { __sounds?: string[] }
  ;(w.__sounds ??= []).push(name)
  try {
    const a = new Audio(URLS[name])
    a.volume = 0.7
    void a.play().catch(() => {})
  } catch {
    /* no audio device */
  }
}
