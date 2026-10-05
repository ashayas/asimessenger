import { encodeWav } from '@shared/wav'

const TARGET_RATE = 16000

function resample(chunks: Float32Array[], from: number): Float32Array[] {
  if (from === TARGET_RATE) return chunks
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) { all.set(c, o); o += c.length }
  const ratio = from / TARGET_RATE
  const out = new Float32Array(Math.floor(all.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio
    const i0 = Math.floor(p)
    out[i] = all[i0]! + ((all[i0 + 1] ?? all[i0]!) - all[i0]!) * (p - i0)
  }
  return [out]
}

export interface Recording {
  /** Stop capturing and return a 16 kHz mono WAV. */
  stop(): Promise<Uint8Array>
}

/** Start capturing the microphone. Audio stays in memory until you stop; nothing is sent anywhere by this module. */
export async function startRecording(): Promise<Recording> {
  // Tests (and machines with no audio hardware) swap only the capture step for one second of a quiet tone (silence would be rejected before reaching an engine).
  if (await window.asi.voice.testMode()) {
    return { stop: async () => encodeWav([Float32Array.from({ length: TARGET_RATE }, (_, i) => 0.1 * Math.sin(i / 9))], TARGET_RATE) }
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const ctx = new AudioContext({ sampleRate: TARGET_RATE })
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).href)
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-capture')
  const chunks: Float32Array[] = []
  node.port.onmessage = (e: MessageEvent<Float32Array>) => chunks.push(e.data)
  src.connect(node)
  return {
    async stop() {
      src.disconnect()
      node.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      const rate = ctx.sampleRate
      await ctx.close()
      return encodeWav(resample(chunks, rate), TARGET_RATE)
    }
  }
}
