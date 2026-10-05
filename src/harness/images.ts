import { readFileSync, statSync } from 'node:fs'
import { MAX_IMAGE_BYTES } from '@shared/attachments'
import type { UserTurn } from '@shared/events'

export interface LoadedImage {
  name: string
  mimeType: string
  /** base64, no data: prefix */
  data: string
}

/** Reads a turn's pictures for adapters that pass them natively. Unreadable or oversized ones are skipped (the prompt still names the path). */
export function loadImages(turn: UserTurn): LoadedImage[] {
  const out: LoadedImage[] = []
  for (const i of turn.images ?? []) {
    try {
      if (statSync(i.path).size > MAX_IMAGE_BYTES) continue
      out.push({ name: i.name, mimeType: i.mimeType, data: readFileSync(i.path).toString('base64') })
    } catch { /* gone or unreadable */ }
  }
  return out
}
