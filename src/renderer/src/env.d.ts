/// <reference types="vite/client" />
import type { AsiApi } from '@shared/api'
import type { Friend } from '@shared/models'
import type { DetectedPreset } from '@shared/presets'

declare global {
  interface Window {
    asi: { platform: string; windowFocused(): Promise<boolean>; api: AsiApi; onChanged(cb: (topic: string) => void): () => void; pickFolder(): Promise<string | null>; chat: { send(chatId: string, text: string, quote?: { name: string; text: string }): Promise<unknown>; setMode(chatId: string, mode: string): Promise<void>; nudge(chatId: string): Promise<boolean>; openNextUnread(): Promise<string | null>; toastOpenChat(chatId: string): Promise<void>; toastDismiss(): Promise<void>; interrupt(chatId: string): Promise<void>; respond(chatId: string, reqId: string, answer: string, reason?: string): Promise<void>; openWindow(chatId: string): Promise<void> }; friends: { detect(): Promise<DetectedPreset[]>; availability(): Promise<Record<string, boolean>>; addPreset(id: string): Promise<Friend>; addCustom(c: { name: string; command: string; args: string[]; kind: 'acp' | 'pty' }): Promise<Friend>; testAcp(command: string, args: string[]): Promise<{ ok: true; agent: string } | { ok: false; error: string }>; openAddWindow(): Promise<void> }; safety: { setGlobalDangerous(on: boolean): Promise<void>; setFriendDangerous(id: string, on: boolean): Promise<void>; openOptions(): Promise<void> } }
  }
}
