/// <reference types="vite/client" />
import type { AsiApi } from '@shared/api'

declare global {
  interface Window {
    asi: { platform: string; api: AsiApi; onChanged(cb: (topic: string) => void): () => void; pickFolder(): Promise<string | null>; chat: { send(chatId: string, text: string, quote?: { name: string; text: string }): Promise<unknown>; interrupt(chatId: string): Promise<void>; respond(chatId: string, reqId: string, answer: string, reason?: string): Promise<void>; openWindow(chatId: string): Promise<void> } }
  }
}
