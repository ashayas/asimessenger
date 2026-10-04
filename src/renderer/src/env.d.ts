/// <reference types="vite/client" />
import type { AsiApi } from '@shared/api'

declare global {
  interface Window {
    asi: { platform: string; api: AsiApi; onChanged(cb: (topic: string) => void): () => void; pickFolder(): Promise<string | null> }
  }
}
