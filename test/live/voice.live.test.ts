import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { cohereEngine } from '../../src/main/cohere-engine'
import { appleEngine } from '../../src/main/voice'

// ASI_LIVE_VOICE_DIR points at a dir containing venv/ (the MLX runtime) and models/cohere-transcribe-mlx-4bit/.
// Build one with: uv venv --python 3.12 venv && uv pip install --python venv/bin/python -r native/voice-requirements.txt
// and extract dist-models/cohere-transcribe-mlx-4bit.tar into models/.
const dir = process.env['ASI_LIVE_VOICE_DIR']
const python = dir ? join(dir, 'venv/bin/python') : ''
const modelDir = dir ? join(dir, 'models/cohere-transcribe-mlx-4bit') : ''
const ready = !!process.env['ASI_LIVE'] && !!dir && existsSync(python) && existsSync(join(modelDir, 'model.safetensors')) && process.platform === 'darwin'

const work = mkdtempSync(join(tmpdir(), 'asi-voice-live-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const speak = (text: string): string => {
  const aiff = join(work, `${Math.abs(text.length * 7919)}.aiff`)
  const wav = aiff.replace('.aiff', '.wav')
  execFileSync('say', ['-o', aiff, text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  return wav
}
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean)
const wer = (ref: string, hyp: string) => {
  const r = words(ref), h = words(hyp)
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)] as number[])
  for (let j = 1; j <= h.length; j++) d[0]![j] = j
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1))
  return d[r.length]![h.length]! / r.length
}

describe.skipIf(!ready)('Cohere Transcribe (MLX 4-bit) on this Mac', () => {
  const engine = cohereEngine({ python, script: resolve('native/cohere_transcribe.py'), modelDir: async () => modelDir, runtimeInstalled: async () => true })
  afterAll(() => engine.stop())

  test('transcribes speech accurately and keeps the model warm for the next clip', async () => {
    const text = 'Please run the unit tests and then open a pull request for the authentication fix.'
    const t0 = Date.now()
    const first = await engine.transcribe(speak(text), 'en-US')
    const coldMs = Date.now() - t0
    expect(wer(text, first)).toBeLessThanOrEqual(0.15)
    const t1 = Date.now()
    const second = await engine.transcribe(speak('The refresh token race is fixed.'), 'en-US')
    expect(wer('The refresh token race is fixed.', second)).toBeLessThanOrEqual(0.2)
    expect(Date.now() - t1).toBeLessThan(coldMs) // no second model load
    expect(await engine.available()).toBe(true)
  })

  test('silence returns empty text instead of an error', async () => {
    const silent = join(work, 'silence.wav')
    execFileSync('python3', ['-c', `import wave;w=wave.open(${JSON.stringify(silent)},'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\\x00\\x00'*16000);w.close()`])
    expect((await engine.transcribe(silent, 'en')).trim().length).toBeLessThan(20)
  })

  test('the model never touches the network (offline flags are on)', () => {
    const src = readFileSync('src/main/cohere-engine.ts', 'utf8')
    expect(src).toContain("HF_HUB_OFFLINE: '1'")
  })
})

describe.skipIf(!process.env['ASI_LIVE'] || process.platform !== 'darwin')('Apple helper', () => {
  test('reports status and on-device support without prompting', async () => {
    const out = execFileSync('resources/bin/asi-speech', ['--status']).toString()
    expect(JSON.parse(out)).toMatchObject({ onDevice: true })
    expect(await appleEngine('resources/bin/asi-speech').available()).toBe(true)
  })
})
