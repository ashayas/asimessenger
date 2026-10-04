import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { appleEngine, createVoiceService, fakeEngine, type VoiceEngine } from '../../src/main/voice'
import { encodeWav } from '../../src/shared/wav'

const clip = (seconds: number) => encodeWav([new Float32Array(Math.round(16000 * seconds))])
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
