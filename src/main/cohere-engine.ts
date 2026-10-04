import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { VoiceEngine } from './voice'

const IDLE_MS = 5 * 60_000
const LOAD_TIMEOUT_MS = 180_000
const REQUEST_TIMEOUT_MS = 120_000

export interface CohereDeps {
  python: string
  script: string
  /** Directory containing config.json + model.safetensors, or null when not installed. */
  modelDir: () => Promise<string | null>
  runtimeInstalled: () => Promise<boolean>
}

/** Cohere Transcribe on MLX: a Python sidecar that keeps the model warm, then exits after 5 idle minutes. */
export function cohereEngine(d: CohereDeps): VoiceEngine & { stop(): void } {
  let proc: ChildProcessWithoutNullStreams | null = null
  let ready: Promise<void> | null = null
  let next = 1
  const waiting = new Map<number, { resolve(t: string): void; reject(e: Error): void }>()
  let idle: ReturnType<typeof setTimeout> | null = null

  const stop = () => {
    if (idle) clearTimeout(idle)
    proc?.kill('SIGTERM')
    proc = null
    ready = null
    for (const w of waiting.values()) w.reject(new Error('the speech model stopped'))
    waiting.clear()
  }

  async function start(): Promise<void> {
    const dir = await d.modelDir()
    if (!dir) throw new Error('the Cohere Transcribe model is not installed')
    const child = spawn(d.python, [d.script, dir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONUNBUFFERED: '1' } })
    proc = child
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-1500) })
    ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { stop(); reject(new Error('the speech model took too long to load')) }, LOAD_TIMEOUT_MS)
      createInterface({ input: child.stdout }).on('line', (line) => {
        let m: { ready?: boolean; id?: number; text?: string; error?: string; fatal?: string }
        try { m = JSON.parse(line) } catch { return }
        if (m.ready) { clearTimeout(t); resolve() }
        else if (m.fatal) { clearTimeout(t); reject(new Error(m.fatal)) }
        else if (m.id !== undefined) {
          const w = waiting.get(m.id)
          waiting.delete(m.id)
          if (m.error) w?.reject(new Error(m.error)); else w?.resolve(m.text ?? '')
        }
      })
      child.on('exit', (code) => {
        clearTimeout(t)
        if (proc === child) { proc = null; ready = null }
        const err = new Error(`the speech model exited (${code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)
        reject(err)
        for (const w of waiting.values()) w.reject(err)
        waiting.clear()
      })
    })
    await ready
  }

  return {
    id: 'cohere-mlx',
    name: 'Cohere Transcribe (MLX 4-bit)',
    stop,
    available: async () => (await d.runtimeInstalled()) && (await d.modelDir()) !== null,
    async transcribe(wavPath, language) {
      if (!proc) await start()
      else await ready
      if (idle) clearTimeout(idle)
      idle = setTimeout(stop, IDLE_MS)
      idle.unref()
      const id = next++
      return new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => { waiting.delete(id); reject(new Error('transcription timed out')) }, REQUEST_TIMEOUT_MS)
        waiting.set(id, { resolve: (x) => { clearTimeout(t); resolve(x) }, reject: (e) => { clearTimeout(t); reject(e) } })
        proc!.stdin.write(JSON.stringify({ id, wav: wavPath, language: language.split('-')[0] || 'en' }) + '\n')
      })
    }
  }
}
