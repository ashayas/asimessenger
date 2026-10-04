import nudge from '../../../assets/sounds/nudge.wav?url'
import message from '../../../assets/sounds/message.wav?url'
import signin from '../../../assets/sounds/signin.wav?url'

const URLS = { nudge, message, signin } as const
export type SoundName = keyof typeof URLS

// Options › Sounds. Cached; refreshed whenever any window changes a setting.
const prefs = { on: true, volume: 0.7 }
async function loadPrefs(): Promise<void> {
  try {
    prefs.on = await window.asi.api.settings.get<boolean>('soundsOn', true)
    prefs.volume = await window.asi.api.settings.get<number>('soundVolume', 0.7)
  } catch { /* settings not reachable (storybook, tests) */ }
}
if (typeof window !== 'undefined' && window.asi) {
  void loadPrefs()
  window.asi.onChanged((t) => { if (t === 'settings') void loadPrefs() })
}

/** Play a bundled sound unless sounds are off. Fails silently (autoplay policy, no output device). Tests can count plays via window.__sounds. */
export function play(name: SoundName): void {
  if (!prefs.on) return
  const w = window as unknown as { __sounds?: string[] }
  ;(w.__sounds ??= []).push(name)
  try {
    const a = new Audio(URLS[name])
    a.volume = Math.max(0, Math.min(1, prefs.volume))
    void a.play().catch(() => {})
  } catch {
    /* no audio device */
  }
}
