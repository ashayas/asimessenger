import { execFile } from 'node:child_process'
import type { WebContents } from 'electron'
import type { ChatService } from './chat-service'
import type { HarnessManager } from '../harness/manager'
import { PtySession } from '../harness/pty/session'
import type { Repo } from './db/repo'
import { resumeCommand } from '@shared/resume'

/** Live terminal plumbing for PTY friends, plus "open this chat in Terminal.app". */
export function createTerminalService(deps: { repo: Repo; chat: ChatService; manager: HarnessManager }) {
  const { repo, chat, manager } = deps
  const subs = new Map<string, () => void>() // `${webContentsId}:${chatId}` -> unsubscribe

  const ptyOf = (chatId: string): PtySession => {
    const s = manager.live(chatId)
    if (!(s instanceof PtySession)) throw new Error('this chat is not a raw terminal')
    return s
  }

  return {
    /** Start the PTY if needed, stream its bytes to the caller, and return what has been printed so far. */
    async attach(sender: WebContents, chatId: string): Promise<string> {
      await chat.ensureSession(chatId)
      const s = ptyOf(chatId)
      const key = `${sender.id}:${chatId}`
      subs.get(key)?.()
      const off = s.onRaw((d) => { if (!sender.isDestroyed()) sender.send('asi:pty-data', chatId, d) })
      subs.set(key, off)
      sender.once('destroyed', () => { subs.get(key)?.(); subs.delete(key) })
      return s.buffer
    },
    input(chatId: string, data: string): void { ptyOf(chatId).write(data) },
    resize(chatId: string, cols: number, rows: number): void { ptyOf(chatId).resize(cols, rows) },

    async openExternal(chatId: string): Promise<boolean> {
      const c = await repo.chats.get(chatId)
      const friend = c ? await repo.friends.get(c.friendId) : null
      const ws = c ? await repo.workspaces.get(c.workspaceId) : null
      if (!c || !friend || !ws) return false
      const cmd = resumeCommand(friend, c, ws.path)
      if (!cmd) return false
      await new Promise<void>((resolve, reject) =>
        execFile('osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', cmd], (err) => (err ? reject(err) : resolve()))
      )
      return true
    }
  }
}
