import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { peakLevel, readWavHeader } from '@shared/wav'

export interface VoiceEngine {
  id: string
  name: string
  /** True when it can transcribe right now. */
  available(): Promise<boolean>
  transcribe(wavPath: string, language: string): Promise<string>
}

export const MAX_SECONDS = 120
/** Below this peak (about -38 dBFS) nothing was said. */
export const SILENCE_PEAK = 0.012

/** Apple's on-device recognizer through our small Swift helper. Never leaves the Mac. */
export function appleEngine(helperPath: string): VoiceEngine {
  const run = (args: string[], timeout: number) =>
    new Promise<{ code: number; out: string; signal: string | null; timedOut: boolean }>((resolve) => {
      execFile(helperPath, args, { timeout }, (err, stdout) => resolve({ code: err ? 1 : 0, out: stdout.trim(), signal: err?.signal ?? null, timedOut: !!err?.killed && err.signal === 'SIGTERM' }))
    })
  return {
    id: 'apple',
    name: 'Apple on-device speech',
    available: async () => existsSync(helperPath),
    async transcribe(wavPath, language) {
      const { out, signal, timedOut } = await run([wavPath, language], 60_000)
      if (timedOut) throw new Error('speech recognition took too long')
      // macOS aborts the helper when the app it runs under cannot ask for Speech Recognition permission (a dev run, for example)
      if (!out && signal === 'SIGABRT') throw new Error('macOS would not let ASI Messenger ask for Speech Recognition permission here. The installed app asks once; from source, allow Speech Recognition for your terminal in System Settings, Privacy & Security, or use Cohere Transcribe in Options, Voice.')
      let json: { text?: string; error?: string }
      try { json = JSON.parse(out.split('\n').pop() ?? '{}') } catch { throw new Error('the speech helper returned nothing') }
      if (json.error) throw new Error(json.error)
      return json.text ?? ''
    }
  }
}

/** Test double: ASI_VOICE_FAKE="text" returns it for any recording. */
export function fakeEngine(text: string): VoiceEngine {
  return { id: 'fake', name: 'Fake', available: async () => true, transcribe: async () => text }
}

export function createVoiceService(engines: VoiceEngine[], pick: () => Promise<string | null>) {
  return {
    async status(): Promise<{ engines: { id: string; name: string; available: boolean }[]; selected: string | null }> {
      const list = await Promise.all(engines.map(async (e) => ({ id: e.id, name: e.name, available: await e.available() })))
      return { engines: list, selected: await this.selectedId() }
    },
    /** The chosen engine if usable, else the first available one (Apple speech is the zero-download default). */
    async selectedId(): Promise<string | null> {
      const want = await pick()
      for (const id of [want, ...engines.map((e) => e.id)]) {
        const e = engines.find((x) => x.id === id)
        if (e && (await e.available())) return e.id
      }
      return null
    },
    async transcribe(wav: Uint8Array, language = 'en-US'): Promise<{ text: string; engine: string; seconds: number; silent?: boolean }> {
      const info = readWavHeader(wav)
      if (!info) throw new Error('that does not look like a recording')
      if (info.seconds < 0.25) return { text: '', engine: '', seconds: info.seconds } // a stray click
      // speech models invent words for pure silence, so a clip that never rises above the noise floor is not sent to one
      if (peakLevel(wav) < SILENCE_PEAK) return { text: '', engine: '', seconds: info.seconds, silent: true }
      if (info.seconds > MAX_SECONDS) throw new Error(`recordings are limited to ${MAX_SECONDS} seconds`)
      const id = await this.selectedId()
      const engine = engines.find((e) => e.id === id)
      if (!engine) throw new Error('no speech engine is available')
      const dir = await mkdtemp(join(tmpdir(), 'asi-voice-'))
      const file = join(dir, 'clip.wav')
      try {
        await writeFile(file, wav)
        return { text: (await engine.transcribe(file, language)).trim(), engine: engine.id, seconds: info.seconds }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}

export type VoiceService = ReturnType<typeof createVoiceService>
