import { expect, test } from 'vitest'
import { encodeWav, readWavHeader } from '../../src/shared/wav'

test('encodes a valid 16 kHz mono 16-bit WAV from several chunks', () => {
  const wav = encodeWav([new Float32Array([0, 0.5, -0.5]), new Float32Array([1, -1, 2, -2])])
  expect(readWavHeader(wav)).toMatchObject({ sampleRate: 16000, channels: 1, bits: 16, samples: 7 })
  const v = new DataView(wav.buffer)
  expect(v.getInt16(44, true)).toBe(0)
  expect(v.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff))
  expect(v.getInt16(48, true)).toBe(-0x4000)
  expect(v.getInt16(50, true)).toBe(0x7fff) // 1.0
  expect(v.getInt16(52, true)).toBe(-0x8000) // -1.0
  expect(v.getInt16(54, true)).toBe(0x7fff) // clipped
  expect(v.getInt16(56, true)).toBe(-0x8000)
})

test('empty recordings and non-WAV data are handled', () => {
  expect(readWavHeader(encodeWav([]))).toMatchObject({ samples: 0, seconds: 0 })
  expect(readWavHeader(new Uint8Array(10))).toBeNull()
  expect(readWavHeader(new Uint8Array(64))).toBeNull()
})

test('peakLevel reads the loudest sample as 0..1', async () => {
  const { peakLevel } = await import('../../src/shared/wav')
  expect(peakLevel(encodeWav([new Float32Array(100)]))).toBe(0)
  expect(peakLevel(encodeWav([Float32Array.from([0, 0.5, -0.25, 0])]))).toBeCloseTo(0.5, 3)
  expect(peakLevel(encodeWav([Float32Array.from([-1])]))).toBe(1)
  expect(peakLevel(new Uint8Array(10))).toBe(0)
})
