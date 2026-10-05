import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { loginEnv } from '../harness/env'
import { isAllowedNavigation, normalizeUrl } from '@shared/browser'
import type { Repo } from './db/repo'
import type { Message } from '@shared/models'
import type { PermDecision, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'
import { canUseMode, lockedReason } from '@shared/safety'
import type { HarnessManager } from '../harness/manager'
import { attachmentPrompt, imageMime, imagePrompt, MAX_IMAGE_BYTES, safeImageName } from '@shared/attachments'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { readPickedFile } from './attachments'
import type { Ingestor } from './ingest'

const TITLE_MAX = 42
const autoTitle = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX - 1) + '…' : one
}

const NUDGE_COOLDOWN_MS = 3000

const SHELL_OUTPUT_MAX = 100_000
const SHELL_TIMEOUT_MS = 120_000

export interface Opener {
  url(u: string): void
  path(p: string): void
}

export function createChatService(deps: { repo: Repo; manager: HarnessManager; ingestor: Ingestor; notify: (topic: string) => void; opener?: Opener }) {
  const { repo, manager, ingestor, notify } = deps
  const opener: Opener = deps.opener ?? { url: () => {}, path: () => {} }
  const shells = new Map<string, ChildProcess>()
  const lastNudge = new Map<string, number>()
  /** Questions an agent asked through ask_user, waiting for you. */
  const asks = new Map<string, { chatId: string; resolve(answer: string): void }>()
  const cancelAsks = (chatId: string, why: string) => {
    for (const [id, a] of asks) if (a.chatId === chatId) { asks.delete(id); a.resolve(why) }
  }

  /** `<workspace>/.attachments`, created on demand. Pictures live in the workspace so the agent's own file tools can open them. */
  async function attachmentsDir(chatId: string): Promise<string> {
    const chat = await repo.chats.get(chatId)
    if (!chat) throw new Error(`unknown chat ${chatId}`)
    const ws = await repo.workspaces.get(chat.workspaceId)
    const dir = join(ws?.path ?? process.cwd(), '.attachments')
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** A picture from anywhere on disk is copied into the workspace unless it is already inside it. */
  async function inWorkspace(chatId: string, path: string): Promise<string> {
    const st = await stat(path)
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is larger than 10 MB`)
    const chat = await repo.chats.get(chatId)
    const ws = chat ? await repo.workspaces.get(chat.workspaceId) : null
    const root = ws?.path ?? process.cwd()
    if (path === root || path.startsWith(root + sep)) return path
    const dest = join(await attachmentsDir(chatId), safeImageName(basename(path)))
    await copyFile(path, dest)
    return dest
  }

  return {
    async send(chatId: string, text: string, quote?: UserTurn['quote'], opts: { silentUser?: boolean; images?: UserTurn['images'] } = {}): Promise<Message | null> {
      const clean = text.trim()
      if (!clean) return null
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      // "!cmd" runs a shell command here; "/open <url|path>" opens it. Neither goes to the agent.
      if (clean.startsWith('!') && clean.length > 1 && !opts.silentUser) return this.runShell(chatId, clean.slice(1).trim())
      if (/^\/open\s+\S/.test(clean) && !opts.silentUser) return this.openTarget(chatId, clean.replace(/^\/open\s+/, '').trim())
      const friend = await repo.friends.get(chat.friendId)
      if (!friend) throw new Error(`unknown friend ${chat.friendId}`)
      const ws = await repo.workspaces.get(chat.workspaceId)
      const shown = opts.silentUser ? null : await repo.messages.append({ chatId, role: 'user', kind: 'text', body: { text: clean, quote }, text: clean })
      if (chat.title === 'New chat') await repo.chats.rename(chatId, autoTitle(opts.silentUser ? (await repo.messages.list(chatId)).find((m) => m.kind === 'attachment')?.text ?? clean : clean))
      notify('messages')
      try {
        await manager.send(chat, friend, ws?.path ?? process.cwd(), { text: clean, quote, images: opts.images })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await repo.messages.append({ chatId, role: 'system', kind: 'error', body: { error: message }, text: message })
        await repo.chats.setStatus(chatId, 'online', `x_x ${message}`)
        notify('messages'); notify('chats')
      }
      return shown
    },

    /** "!cmd": run a command in the chat's workspace and show it as a block. The agent does not see it. */
    async runShell(chatId: string, cmd: string): Promise<Message | null> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const ws = await repo.workspaces.get(chat.workspaceId)
      const cwd = ws?.path ?? process.cwd()
      const id = `sh-${randomUUID()}`
      const base = { t: 'tool', id, kind: 'exec', title: 'Shell', command: cmd, cwd } as const
      const msg = await repo.messages.append({ chatId, role: 'user', kind: 'tool', body: { ...base, done: false }, text: cmd })
      notify('messages')
      const env = await loginEnv()
      const started = Date.now()
      let out = ''
      const child = spawn(process.env['SHELL'] || '/bin/zsh', ['-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      shells.set(chatId, child)
      const take = (d: Buffer) => { if (out.length < SHELL_OUTPUT_MAX) out += d.toString('utf8') }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const timer = setTimeout(() => child.kill('SIGTERM'), SHELL_TIMEOUT_MS)
      const code = await new Promise<number>((r) => { child.on('error', () => r(127)); child.on('close', (c, sig) => r(c ?? (sig ? 130 : 1))) })
      clearTimeout(timer)
      shells.delete(chatId)
      await repo.messages.update(msg.id, { body: { ...base, output: out.slice(0, SHELL_OUTPUT_MAX), exit: code, durationMs: Date.now() - started, done: true } })
      notify('messages')
      return msg
    },

    /** "/open <target>": web URLs open in the in-app browser, anything else is a path inside the workspace. */
    async openTarget(chatId: string, target: string): Promise<Message | null> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const ws = await repo.workspaces.get(chat.workspaceId)
      const say = async (text: string) => { const m = await repo.messages.append({ chatId, role: 'system', kind: 'system', body: { text }, text }); notify('messages'); return m }
      const asUrl = normalizeUrl(target)
      const existsHere = existsSync(isAbsolute(target) ? target : resolvePath(ws?.path ?? process.cwd(), target)) // README.md is a file, not the .md domain
      if (!existsHere && (/^(https?:\/\/|localhost|127\.0\.0\.1|\[::1\])/i.test(target) || (!target.includes('/') && /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(target)))) {
        if (!isAllowedNavigation(asUrl)) return say(`Cannot open ${target}`)
        opener.url(asUrl)
        return say(`Opened ${asUrl} in the browser.`)
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:/i.test(target)) return say(`Cannot open ${target}: only web addresses and file paths`)
      const root = ws?.path ?? process.cwd()
      const full = isAbsolute(target) ? target : resolvePath(root, target)
      opener.path(full)
      return say(`Opened ${full}.`)
    },

    /** Start (or fetch) the live agent session for a chat without sending anything. */
    async ensureSession(chatId: string) {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const friend = await repo.friends.get(chat.friendId)
      if (!friend) throw new Error(`unknown friend ${chat.friendId}`)
      const ws = await repo.workspaces.get(chat.workspaceId)
      return manager.session(chat, friend, ws?.path ?? process.cwd(), chat.mode)
    },

    /** Save a pasted or dropped picture into the chat's workspace (`.attachments/`) and return where it went. */
    async saveImage(chatId: string, name: string, bytes: Uint8Array): Promise<string> {
      if (!imageMime(name)) throw new Error('only png, jpg, gif and webp pictures can be attached')
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('that picture is larger than 10 MB')
      const dir = await attachmentsDir(chatId)
      const path = join(dir, safeImageName(name))
      await writeFile(path, bytes)
      return path
    },

    /** Send files to the agent; they appear in the transcript as attachments you can reopen. Pictures go as images. */
    async sendFiles(chatId: string, paths: string[], note = ''): Promise<void> {
      const parts: string[] = []
      const images: NonNullable<UserTurn['images']> = []
      for (const [i, p0] of paths.entries()) {
        const lead = parts.length === 0 ? note : ''
        const mime = imageMime(p0)
        if (mime) {
          const path = await inWorkspace(chatId, p0)
          const name = basename(path)
          const m = await repo.messages.append({ chatId, role: 'user', kind: 'attachment', body: { t: 'attachment', id: `u-${Date.now()}-${i}`, kind: 'image', name, path }, text: name })
          await repo.attachments.add({ messageId: m.id, kind: 'image', name, path })
          images.push({ path, mimeType: mime, name })
          parts.push(imagePrompt(name, path, lead))
          continue
        }
        const f = await readPickedFile(p0)
        const m = await repo.messages.append({ chatId, role: 'user', kind: 'attachment', body: { t: 'attachment', id: `u-${Date.now()}-${i}`, kind: f.kind, name: f.name, path: p0, body: f.text }, text: f.name })
        await repo.attachments.add({ messageId: m.id, kind: f.kind, name: f.name, path: p0, body: f.text })
        parts.push(attachmentPrompt(f.name, f.text, lead))
      }
      // your own words belong in the transcript too, not only in the prompt the agent receives
      if (note.trim() && parts.length) await repo.messages.append({ chatId, role: 'user', kind: 'text', body: { text: note.trim() }, text: note.trim() })
      notify('messages')
      if (parts.length) await this.send(chatId, parts.join('\n\n'), undefined, { silentUser: true, images })
    },

    /** Send a drawing: shows as an image attachment and tells the agent where the PNG and editable source are. */
    async sendDoodle(chatId: string, name: string, pngPath: string, sourcePath: string, note = ''): Promise<void> {
      const m = await repo.messages.append({ chatId, role: 'user', kind: 'attachment', body: { t: 'attachment', id: `doodle-${Date.now()}`, kind: 'image', name: `${name}.png`, path: pngPath }, text: `${name}.png` })
      await repo.attachments.add({ messageId: m.id, kind: 'image', name: `${name}.png`, path: pngPath })
      notify('messages')
      const text = `${note ? note + '\n\n' : ''}I drew a diagram for you. Image: ${pngPath} (editable Excalidraw source: ${sourcePath}). Please open the image and take it into account.`
      await this.send(chatId, text, undefined, { silentUser: true })
    },

    /** Change a chat's permission mode. Dangerous needs the global switch AND the friend's opt-in. */
    async setMode(chatId: string, mode: Mode): Promise<void> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const friend = await repo.friends.get(chat.friendId)
      const state = { globalDangerous: await repo.settings.get('allowDangerous', false), friendDangerous: !!friend?.dangerousAllowed }
      if (!canUseMode(mode, state)) throw new Error(lockedReason(state) ?? 'that mode is not allowed')
      await repo.chats.setMode(chatId, mode)
      manager.setMode(chatId, mode)
      notify('chats')
    },

    /** Global switch. Turning it off drops every dangerous chat back to Ask and restarts those sessions. */
    async setGlobalDangerous(on: boolean): Promise<void> {
      await repo.settings.set('allowDangerous', on)
      notify('settings')
      if (!on) await this.revokeDangerous()
    },

    async setFriendDangerous(friendId: string, on: boolean): Promise<void> {
      await repo.friends.setDangerousAllowed(friendId, on)
      notify('friends')
      if (!on) await this.revokeDangerous(friendId)
    },

    async revokeDangerous(friendId?: string): Promise<void> {
      for (const c of await repo.chats.list(friendId ? { friendId } : {})) {
        if (c.mode !== 'dangerous') continue
        await repo.chats.setMode(c.id, 'ask')
        await manager.dispose(c.id) // a bypass-permissions process must not keep running
      }
      notify('chats')
    },

    /** Plain stop. */
    async interrupt(chatId: string): Promise<void> {
      cancelAsks(chatId, 'The human interrupted before answering.')
      shells.get(chatId)?.kill('SIGINT')
      await manager.interrupt(chatId)
    },

    /** ask_user from the MCP bridge: shows a question card and resolves with the answer. */
    async askUser(chatId: string, prompt: string, choices?: string[]): Promise<string> {
      const reqId = `ask-${randomUUID()}`
      const answered = new Promise<string>((resolve) => asks.set(reqId, { chatId, resolve }))
      await ingestor.ingest(chatId, { t: 'question', reqId, prompt, choices })
      return answered
    },

    /** The classic: interrupt whatever the agent is doing, with a transcript line. Rate limited per chat. */
    async nudge(chatId: string, now = Date.now()): Promise<boolean> {
      if (now - (lastNudge.get(chatId) ?? 0) < NUDGE_COOLDOWN_MS) return false
      lastNudge.set(chatId, now)
      const running = manager.isLive(chatId) && (await repo.chats.get(chatId))?.status !== 'online'
      await repo.messages.append({ chatId, role: 'system', kind: 'nudge', body: { interrupted: running }, text: running ? 'You sent a nudge and stopped the agent.' : 'You sent a nudge.' })
      notify('messages')
      cancelAsks(chatId, 'The human sent a nudge instead of answering.')
      if (running) await manager.interrupt(chatId)
      return true
    },

    /** Answer a permission request or question card. */
    async respond(chatId: string, reqId: string, answer: PermDecision | string, reason?: string): Promise<void> {
      await ingestor.idle(chatId)
      const ask = asks.get(reqId)
      const msgs = await repo.messages.list(chatId)
      const card = msgs.find((m) => (m.kind === 'permission' || m.kind === 'question') && (m.body as { reqId?: string }).reqId === reqId)
      if (card) {
        const body = card.body as Record<string, unknown>
        await repo.messages.update(card.id, { body: card.kind === 'permission' ? { ...body, decision: answer, reason: reason ?? null } : { ...body, answer } })
      }
      await repo.chats.setStatus(chatId, 'busy', null)
      notify('messages'); notify('chats')
      if (ask) { asks.delete(reqId); ask.resolve(String(answer)); return }
      manager.respond(chatId, reqId, answer, reason)
    }
  }
}

export type ChatService = ReturnType<typeof createChatService>
