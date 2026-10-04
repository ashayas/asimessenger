/** 16-bit PCM mono WAV from float samples in [-1, 1]. */
export function encodeWav(chunks: Float32Array[], sampleRate = 16000): Uint8Array {
  const n = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(44 + n * 2)
  const v = new DataView(out.buffer)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  let o = 44
  for (const c of chunks) for (let i = 0; i < c.length; i++) { const s = Math.max(-1, Math.min(1, c[i]!)); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2 }
  return out
}

export interface WavInfo { sampleRate: number; channels: number; bits: number; samples: number; seconds: number }

export function readWavHeader(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  const channels = v.getUint16(22, true)
  const sampleRate = v.getUint32(24, true)
  const bits = v.getUint16(34, true)
  const samples = v.getUint32(40, true) / (bits / 8) / channels
  return { sampleRate, channels, bits, samples, seconds: samples / sampleRate }
}
