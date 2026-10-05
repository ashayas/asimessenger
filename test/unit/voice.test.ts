import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { appleEngine, createVoiceService, fakeEngine, type VoiceEngine } from '../../src/main/voice'
import { encodeWav } from '../../src/shared/wav'

/** A clip with a clear tone in it (a real recording has sound; pure zeros count as silence). */
const clip = (seconds: number, level = 0.3) => encodeWav([Float32Array.from({ length: Math.round(16000 * seconds) }, (_, i) => level * Math.sin(i / 8))])
const engine = (id: string, available: boolean, text = id): VoiceEngine => ({ id, name: id, available: async () => available, transcribe: async () => ` ${text} ` })

test('picks the chosen engine, falls back to the first available one, and reports status', async () => {
  const svc = createVoiceService([engine('apple', true), engine('cohere', true)], async () => 'cohere')
  expect((await svc.transcribe(clip(1))).engine).toBe('cohere')
  const down = createVoiceService([engine('apple', true), engine('cohere', false)], async () => 'cohere')
  expect((await down.transcribe(clip(1))).engine).toBe('apple') // chosen model not installed: Apple speech still works
  expect((await down.status()).engines).toEqual([{ id: 'apple', name: 'apple', available: true }, { id: 'cohere', name: 'cohere', available: false }])
  const none = createVoiceService([engine('apple', false)], async () => null)
  await expect(none.transcribe(clip(1))).rejects.toThrow(/no speech engine/)
})

test('trims text, ignores stray clicks, and rejects junk and very long recordings', async () => {
  const svc = createVoiceService([fakeEngine('  hello there ')], async () => null)
  expect((await svc.transcribe(clip(1))).text).toBe('hello there')
  expect(await svc.transcribe(clip(0.1))).toMatchObject({ text: '', engine: '' })
  await expect(svc.transcribe(new Uint8Array(100))).rejects.toThrow(/recording/)
  await expect(svc.transcribe(clip(121))).rejects.toThrow(/limited/)
})

test('the Apple helper is built and says it can run on-device', async () => {
  const helper = 'resources/bin/asi-speech'
  if (!existsSync(helper)) return // not on macOS / swiftc missing
  const apple = appleEngine(helper)
  expect(await apple.available()).toBe(true)
  expect(readFileSync(helper).length).toBeGreaterThan(10_000)
  expect(await appleEngine('/nonexistent/asi-speech').available()).toBe(false)
})

test('a helper that macOS aborts, or that hangs, produces an explanation instead of "returned nothing"', async () => {
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'asi-helper-'))
  const aborting = join(dir, 'abort.sh'); writeFileSync(aborting, '#!/bin/sh\nkill -ABRT $$\n'); chmodSync(aborting, 0o755)
  await expect(appleEngine(aborting).transcribe('/x.wav', 'en-US')).rejects.toThrow(/Speech Recognition permission/)
  const silent = join(dir, 'silent.sh'); writeFileSync(silent, '#!/bin/sh\nexit 0\n'); chmodSync(silent, 0o755)
  await expect(appleEngine(silent).transcribe('/x.wav', 'en-US')).rejects.toThrow(/returned nothing/)
  const ok = join(dir, 'ok.sh'); writeFileSync(ok, '#!/bin/sh\necho \'{"text":"hello there"}\'\n'); chmodSync(ok, 0o755)
  expect(await appleEngine(ok).transcribe('/x.wav', 'en-US')).toBe('hello there')
})

test('a clip with no sound never reaches an engine, which would make words up; quiet speech still does', async () => {
  let calls = 0
  const counting: VoiceEngine = { id: 'apple', name: 'apple', available: async () => true, transcribe: async () => { calls++; return 'invented words' } }
  const svc = createVoiceService([counting], async () => null)
  const silent = await svc.transcribe(clip(2, 0))
  expect(silent).toEqual({ text: '', engine: '', seconds: 2, silent: true })
  expect((await svc.transcribe(clip(2, 0.004))).silent).toBe(true) // room noise
  expect(calls).toBe(0)
  expect((await svc.transcribe(clip(2, 0.05))).text).toBe('invented words') // quiet but real
  expect(calls).toBe(1)
})
