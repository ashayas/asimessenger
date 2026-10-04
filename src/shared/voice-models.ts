export interface VoiceModel {
  id: string
  name: string
  blurb: string
  archive: string
  /** Size of the downloaded archive. */
  bytes: number
  sha256: string
  /** Tried in order. The GitHub Release asset first; no Hugging Face account or token is ever needed. */
  urls: string[]
  recommended?: boolean
}

/** Rough size of the Python runtime (MLX + mlx-audio) installed beside the model. */
export const RUNTIME_BYTES = 400 * 1024 * 1024

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: 'cohere-transcribe-mlx-4bit',
    name: 'Cohere Transcribe (MLX 4-bit)',
    blurb: '2B-parameter speech model, 14 languages, runs on the Apple GPU. Recommended.',
    archive: 'cohere-transcribe-mlx-4bit.tar',
    bytes: 1510070272,
    sha256: '518aca1cb666bea44957a3ebfbef447328c1292b3dc3f3d7292fd279365f9bb3',
    urls: ['https://github.com/ashayas/asimessenger/releases/download/models-v1/cohere-transcribe-mlx-4bit.tar'],
    recommended: true
  }
]

export const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

/** Disk needed to install: the archive plus its extracted copy, with headroom. */
export const neededBytes = (m: VoiceModel, withRuntime: boolean): number => Math.ceil((m.bytes * 2 + (withRuntime ? RUNTIME_BYTES : 0)) * 1.2)
