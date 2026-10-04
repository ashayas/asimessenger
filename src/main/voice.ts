import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWavHeader } from '@shared/wav'

export interface VoiceEngine {
  id: string
  name: string
  /** True when it can transcribe right now. */
  available(): Promise<boolean>
  transcribe(wavPath: string, language: string): Promise<string>
}

export const MAX_SECONDS = 120

/** Apple's on-device recognizer through our small Swift helper. Never leaves the Mac. */
export function appleEngine(helperPath: string): VoiceEngine {
  const run = (args: string[], timeout: number) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(helperPath, args, { timeout }, (err, stdout) => resolve({ code: err ? 1 : 0, out: stdout.trim() }))
    })
  return {
    id: 'apple',
    name: 'Apple on-device speech',
    available: async () => existsSync(helperPath),
    async transcribe(wavPath, language) {
      const { out } = await run([wavPath, language], 60_000)
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
    async transcribe(wav: Uint8Array, language = 'en-US'): Promise<{ text: string; engine: string; seconds: number }> {
      const info = readWavHeader(wav)
      if (!info) throw new Error('that does not look like a recording')
      if (info.seconds < 0.25) return { text: '', engine: '', seconds: info.seconds } // a stray click
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
