import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { loginEnv } from '../harness/env'
import { isAllowedNavigation, normalizeUrl } from '@shared/browser'
import type { Repo } from './db/repo'
import type { BoardEntryType, Chat, ChatParticipant, Friend, Message, Mode } from '@shared/models'
import type { PermDecision, UserTurn } from '@shared/events'
import { canUseMode, lockedReason } from '@shared/safety'
import { ruleTitle } from '@shared/title'
import type { HarnessManager, ParticipantTarget } from '../harness/manager'
import { attachmentPrompt, filePrompt, imageMime, imagePrompt, kindForFile, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_PASTED_FILE_BYTES, safeFileName, safeImageName } from '@shared/attachments'
import {
  BOARD_ENTRY_TYPES,
  buildCollaborationPrompt,
  formatBoardEntry,
  formatBoardFile,
  nextAgentId,
  nextParticipantDisplayName,
  parseTargetMentions,
  sanitizeSingleLine,
  type BoardParticipantInfo
} from '@shared/board'
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { readPickedFile } from './attachments'
import type { Ingestor } from './ingest'
import type { Worktrees } from './worktrees'


const NUDGE_COOLDOWN_MS = 3000
/** What a pending ask_user returns when the turn is stopped or nudged. A nudge is between you and the transcript; the agent just learns the question went unanswered. */
const NO_ANSWER = 'The human did not answer.'

const SHELL_OUTPUT_MAX = 100_000
const SHELL_TIMEOUT_MS = 120_000

export interface QueuedPrompt {
  text: string
  quote?: UserTurn['quote']
  /** The agent stopped or failed instead of finishing, so nothing was sent; the prompt waits for you. */
  held: boolean
}

export interface Opener {
  url(u: string): void
  path(p: string): void
  /** Show a file in Finder. */
  reveal?(p: string): void
}

export function createChatService(deps: { repo: Repo; manager: HarnessManager; ingestor: Ingestor; notify: (topic: string) => void; opener?: Opener; worktrees?: Worktrees }) {
  const { repo, manager, ingestor, notify } = deps
  /** Where this chat's agent works: its own worktree when it has one, otherwise the workspace folder. */
  const rootOf = (chat: Chat, ws: { path: string } | null): string => chat.worktreePath ?? ws?.path ?? process.cwd()
  const opener: Opener = deps.opener ?? { url: () => {}, path: () => {} }
  const shells = new Map<string, ChildProcess>()
  const lastNudge = new Map<string, number>()
  /** Questions an agent asked through ask_user, waiting for you. */
  const asks = new Map<string, { chatId: string; resolve(answer: string): void }>()
  /** One follow-up per chat, held while the agent works and sent when it finishes. In memory only, like the turn it waits on. */
  const queued = new Map<string, QueuedPrompt>()
  const cancelAsks = (chatId: string, why: string) => {
    for (const [id, a] of asks) if (a.chatId === chatId) { asks.delete(id); a.resolve(why) }
  }

  /** `<workspace>/.boards/<chatId>.log`, created on demand. Collaborating agents read/grep and append to this shared file. */
  async function boardFilePath(chatId: string): Promise<string> {
    const chat = await repo.chats.get(chatId)
    if (!chat) throw new Error(`unknown chat ${chatId}`)
    const ws = await repo.workspaces.get(chat.workspaceId)
    const dir = join(rootOf(chat, ws), '.boards')
    await mkdir(dir, { recursive: true })
    return join(dir, `${chat.id}.log`)
  }

  /** Harvest any raw lines appended directly to `.boards/<chatId>.log` on disk by a CLI agent before re-rendering canonical state. */
  async function harvestDiskAppends(chatId: string, filePath: string, defaultAgent: { agentId: string; displayName: string }): Promise<void> {
    if (!existsSync(filePath)) return
    const raw = await readFile(filePath, 'utf8').catch(() => '')
    const logIdx = raw.indexOf('\n# [LOG]')
    if (logIdx < 0) return
    const afterLog = raw.slice(logIdx + '\n# [LOG]'.length).split(/\r?\n/)
    for (const line of afterLog) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      // Canonical rendered lines start with ISO timestamp + "| SEQ=" or "DETAIL:AGENT="
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*\|\s*SEQ=\d+/.test(trimmed)) continue
      if (/^DETAIL:AGENT=/.test(trimmed)) continue
      const agentMatch = /\bAGENT=([a-zA-Z0-9_-]+)/i.exec(trimmed)
      const typeMatch = /\bTYPE=(CLAIM|STATUS|FINDING|QUESTION|DONE|TURN|GOAL|USER|INVITE)\b/i.exec(trimmed)
      const agentId = agentMatch?.[1]?.toLowerCase() ?? defaultAgent.agentId
      const entryType = (typeMatch?.[1]?.toUpperCase() ?? 'FINDING') as BoardEntryType
      const cleaned = trimmed
        .replace(/\bAGENT=[a-zA-Z0-9_-]+\s*\|?\s*/i, '')
        .replace(/\bTYPE=[a-zA-Z]+\s*\|?\s*/i, '')
        .trim()
      if (!cleaned) continue
      const participants = await repo.participants.list(chatId)
      const matchedP = participants.find((p) => p.agentId.toLowerCase() === agentId)
      await repo.board.append({
        chatId,
        agentId: matchedP?.agentId ?? agentId,
        agentName: matchedP?.displayName ?? defaultAgent.displayName,
        entryType,
        summary: sanitizeSingleLine(cleaned).slice(0, 240)
      })
    }
  }

  async function rosterFor(chat: Chat): Promise<BoardParticipantInfo[]> {
    const participants = await repo.participants.list(chat.id)
    const friends = new Map((await repo.friends.list()).map((f) => [f.id, f]))
    if (participants.length === 0) {
      const primary = friends.get(chat.friendId)
      return [
        {
          agentId: nextAgentId(primary?.harness ?? 'agent', []),
          displayName: primary?.displayName ?? 'Agent',
          harness: primary?.harness ?? 'agent',
          role: 'lead',
          status: chat.status
        }
      ]
    }
    return participants.map((p) => {
      const f = friends.get(p.friendId)
      return {
        agentId: p.agentId,
        displayName: p.displayName,
        harness: f?.harness ?? 'agent',
        role: p.role,
        status: p.status
      }
    })
  }

  async function syncBoardFile(chatId: string): Promise<string> {
    const chat = await repo.chats.get(chatId)
    if (!chat) throw new Error(`unknown chat ${chatId}`)
    const filePath = await boardFilePath(chatId)
    const roster = await rosterFor(chat)
    const primary = roster[0] ?? { agentId: 'agent-1', displayName: 'Agent', role: null }
    await harvestDiskAppends(chatId, filePath, primary)
    const entries = await repo.board.list(chatId)
    const content = formatBoardFile({
      chatId: chat.id,
      title: chat.title,
      goal: chat.goal ?? null,
      participants: roster,
      entries
    })
    await writeFile(filePath, content, 'utf8')
    return filePath
  }

  /** Ensures the chat's primary Friend is registered as the first participant before adding invited agents. */
  async function ensurePrimaryParticipant(chatId: string): Promise<ChatParticipant[]> {
    const existing = await repo.participants.list(chatId)
    if (existing.length > 0) return existing
    const chat = await repo.chats.get(chatId)
    if (!chat) throw new Error(`unknown chat ${chatId}`)
    const primaryFriend = await repo.friends.get(chat.friendId)
    if (!primaryFriend) throw new Error(`unknown friend ${chat.friendId}`)
    const agentId = nextAgentId(primaryFriend.harness, [])
    const first = await repo.participants.add({
      chatId: chat.id,
      friendId: primaryFriend.id,
      agentId,
      displayName: primaryFriend.displayName,
      role: 'Primary agent',
      harnessSessionId: chat.harnessSessionId
    })
    // If there was a live session keyed under chat.id, dispose it so it resumes cleanly under the participant key
    if (manager.isLive(chat.id)) await manager.dispose(chat.id)
    return [first]
  }

  /** `<workspace>/.attachments`, created on demand. Pictures live in the workspace so the agent's own file tools can open them. */
  async function attachmentsDir(chatId: string): Promise<string> {
    const chat = await repo.chats.get(chatId)
    if (!chat) throw new Error(`unknown chat ${chatId}`)
    const ws = await repo.workspaces.get(chat.workspaceId)
    const dir = join(rootOf(chat, ws), '.attachments')
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** A picture from anywhere on disk is copied into the workspace unless it is already inside it. */
  async function inWorkspace(chatId: string, path: string): Promise<string> {
    const st = await stat(path)
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is larger than 10 MB`)
    const chat = await repo.chats.get(chatId)
    const ws = chat ? await repo.workspaces.get(chat.workspaceId) : null
    const root = chat ? rootOf(chat, ws) : (ws?.path ?? process.cwd())
    if (path === root || path.startsWith(root + sep)) return path
    const dest = join(await attachmentsDir(chatId), safeImageName(basename(path)))
    await copyFile(path, dest)
    return dest
  }

  /** A fresh folder inside `.attachments`, so a file keeps its own name and two files with the same name never collide. */
  async function uniqueAttachmentDir(chatId: string): Promise<string> {
    const dir = join(await attachmentsDir(chatId), `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** Any file goes into the chat's `.attachments` folder (a copy-on-write clone where the disk allows it) unless it already lives in the workspace. */
  async function fileInto(chatId: string, path: string): Promise<string> {
    const chat = await repo.chats.get(chatId)
    const ws = chat ? await repo.workspaces.get(chat.workspaceId) : null
    const root = chat ? rootOf(chat, ws) : (ws?.path ?? process.cwd())
    if (path === root || path.startsWith(root + sep)) return path
    const dest = join(await uniqueAttachmentDir(chatId), safeFileName(basename(path)))
    await copyFile(path, dest, fsConstants.COPYFILE_FICLONE)
    return dest
  }

  /** The real path of a file an agent or a message points at, if (and only if) it is inside this chat's workspace or worktree. */
  async function insideChat(chatId: string, path: string): Promise<string> {
    const chat = await repo.chats.get(chatId)
    if (!chat) throw new Error(`unknown chat ${chatId}`)
    const ws = await repo.workspaces.get(chat.workspaceId)
    const roots = [chat.worktreePath, ws?.path].filter((r): r is string => !!r)
    const real = await realpath(isAbsolute(path) ? path : resolvePath(roots[0] ?? process.cwd(), path))
    for (const r of roots) {
      const root = await realpath(r).catch(() => r)
      if (real === root || real.startsWith(root + sep)) return real
    }
    throw new Error('that file is outside this workspace')
  }

  return {
    async send(chatId: string, text: string, quote?: UserTurn['quote'], opts: { silentUser?: boolean; images?: UserTurn['images']; targetParticipantId?: string } = {}): Promise<Message | null> {
      const clean = text.trim()
      if (!clean) return null
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      // "!cmd" runs a shell command here; "/open <url|path>" opens it; "/reset" starts a fresh agent session; "/goal <text>" sets the shared session goal.
      if (clean.startsWith('!') && clean.length > 1 && !opts.silentUser) return this.runShell(chatId, clean.slice(1).trim())
      if (/^\/open\s+\S/.test(clean) && !opts.silentUser) return this.openTarget(chatId, clean.replace(/^\/open\s+/, '').trim())
      if (clean === '/reset' && !opts.silentUser) return this.reset(chatId)
      if (/^\/goal(?:\s+|$)/i.test(clean) && !opts.silentUser) {
        const goalText = clean.replace(/^\/goal\s*/i, '').trim()
        const path = await this.setGoal(chatId, goalText || null)
        const note = goalText ? `Updated session goal: "${goalText}" (Board: ${path})` : `Cleared session goal.`
        const msg = await repo.messages.append({ chatId, role: 'system', kind: 'system', body: { text: note }, text: note })
        notify('messages')
        return msg
      }
      const friend = await repo.friends.get(chat.friendId)
      if (!friend) throw new Error(`unknown friend ${chat.friendId}`)
      const ws = await repo.workspaces.get(chat.workspaceId)
      const shown = opts.silentUser ? null : await repo.messages.append({ chatId, role: 'user', kind: 'text', body: { text: clean, quote }, text: clean })
      if (chat.titleSource === 'default') await repo.chats.setAutoTitle(chatId, opts.silentUser ? (await repo.messages.list(chatId)).find((m) => m.kind === 'attachment')?.text ?? ruleTitle(clean) : ruleTitle(clean), 'rule')
      notify('messages')
      try {
        const globalDangerous = await repo.settings.get('allowDangerous', false)
        const existingParticipants = await repo.participants.list(chatId)
        const isCollaborative = existingParticipants.length > 0 || !!(chat.goal && chat.goal.trim())

        if (!isCollaborative) {
          const permissionState = { globalDangerous, friendDangerous: friend.dangerousAllowed }
          if (!canUseMode(chat.mode, permissionState)) throw new Error(lockedReason(permissionState) ?? 'that mode is not allowed')
          await manager.send(chat, friend, rootOf(chat, ws), { text: clean, quote, images: opts.images })
          return shown
        }

        // Multi-agent / Shared Session Board flow
        const participants = existingParticipants.length > 0 ? existingParticipants : await ensurePrimaryParticipant(chatId)
        await repo.board.append({
          chatId,
          agentId: 'user',
          agentName: 'User',
          entryType: 'USER',
          summary: sanitizeSingleLine(clean).slice(0, 200),
          detail: clean.length > 200 ? clean : null
        })
        const boardPath = await syncBoardFile(chatId)
        notify('board')

        let targets: ChatParticipant[] = participants
        if (opts.targetParticipantId) {
          const found = participants.find((p) => p.id === opts.targetParticipantId || p.agentId === opts.targetParticipantId)
          if (found) targets = [found]
        } else {
          const mentionedIds = parseTargetMentions(clean, participants)
          if (mentionedIds.length > 0) {
            targets = participants.filter((p) => mentionedIds.includes(p.id))
          }
        }

        const roster = await rosterFor(chat)
        const recentEntries = await repo.board.list(chatId, { limit: 15 })
        const cwd = rootOf(chat, ws)

        await Promise.all(
          targets.map(async (p) => {
            const pFriend: Friend = (await repo.friends.get(p.friendId)) ?? friend
            const permissionState = { globalDangerous, friendDangerous: pFriend.dangerousAllowed }
            if (!canUseMode(chat.mode, permissionState)) throw new Error(lockedReason(permissionState) ?? 'that mode is not allowed')
            const wrappedPrompt = buildCollaborationPrompt({
              boardPath,
              self: {
                agentId: p.agentId,
                displayName: p.displayName,
                harness: pFriend.harness,
                role: p.role,
                status: p.status
              },
              goal: chat.goal ?? null,
              participants: roster,
              recentEntries,
              userText: clean
            })
            const pTarget: ParticipantTarget = {
              id: p.id,
              agentId: p.agentId,
              displayName: p.displayName,
              friendId: p.friendId,
              harnessSessionId: p.harnessSessionId
            }
            await manager.send(chat, pFriend, cwd, { text: wrappedPrompt, quote, images: opts.images }, pTarget)
          })
        )
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
      const cwd = rootOf(chat, ws)
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
      const existsHere = existsSync(isAbsolute(target) ? target : resolvePath(rootOf(chat, ws), target)) // README.md is a file, not the .md domain
      if (!existsHere && (/^(https?:\/\/|localhost|127\.0\.0\.1|\[::1\])/i.test(target) || (!target.includes('/') && /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(target)))) {
        if (!isAllowedNavigation(asUrl)) return say(`Cannot open ${target}`)
        opener.url(asUrl)
        return say(`Opened ${asUrl} in the browser.`)
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:/i.test(target)) return say(`Cannot open ${target}: only web addresses and file paths`)
      const root = rootOf(chat, ws)
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
      return manager.session(chat, friend, rootOf(chat, ws), chat.mode)
    },

    /** A new chat in its own git worktree: a fresh branch from the repo's current HEAD, so parallel agents never touch the same files. */
    async newIsolatedChat(workspaceId: string, friendId: string): Promise<Chat> {
      if (!deps.worktrees) throw new Error('isolated chats are not available')
      const ws = await repo.workspaces.get(workspaceId)
      if (!ws) throw new Error('unknown workspace')
      const wt = await deps.worktrees.create(ws.path)
      try {
        return await repo.chats.create({ workspaceId, friendId, worktree: wt })
      } catch (e) {
        await deps.worktrees.remove(wt.path, wt.branch, ws.path) // nothing references it yet, so clean up
        throw e
      }
    },

    /** What deleting this chat would do to its worktree, for the confirmation. */
    async worktreeInfo(chatId: string): Promise<{ isolated: boolean; branch: string | null; path: string | null; dirty: number }> {
      const chat = await repo.chats.get(chatId)
      if (!chat?.worktreePath || !deps.worktrees) return { isolated: false, branch: null, path: null, dirty: 0 }
      return { isolated: true, branch: chat.branch, path: chat.worktreePath, dirty: await deps.worktrees.dirtyCount(chat.worktreePath) }
    },

    /** How many agents are working or waiting on you in this workspace (closing it stops them). */
    async workingIn(workspaceId: string): Promise<number> {
      return (await repo.chats.list({ workspaceId })).filter((c) => c.status === 'busy' || c.status === 'away').length
    },

    /** Close a workspace: its agents stop and its tab goes, but every chat and its history stays, ready to reopen. */
    async closeWorkspace(workspaceId: string): Promise<string[]> {
      const chats = await repo.chats.list({ workspaceId })
      for (const c of chats) {
        cancelAsks(c.id, NO_ANSWER)
        queued.delete(c.id)
        await manager.dispose(c.id)
        await repo.chats.setStatus(c.id, 'online', null)
      }
      await repo.workspaces.close(workspaceId)
      notify('chats'); notify('queue')
      return chats.map((c) => c.id)
    },

    async reopenWorkspace(workspaceId: string): Promise<void> {
      await repo.workspaces.reopen(workspaceId)
      notify('chats')
    },

    /** Delete a workspace and all its chats. Worktrees go only when nothing would be lost; the notes say what stayed. */
    async deleteWorkspace(workspaceId: string): Promise<{ chats: number; notes: string[] }> {
      const chats = await repo.chats.list({ workspaceId })
      const notes: string[] = []
      for (const c of chats) { const r = await this.deleteChat(c.id); if (r.note) notes.push(r.note) }
      await repo.workspaces.remove(workspaceId)
      notify('chats')
      return { chats: chats.length, notes }
    },

    /** Delete a chat. Its worktree goes with it only when nothing would be lost; otherwise the folder or branch stays and the note says so. */
    async deleteChat(chatId: string): Promise<{ note: string | null }> {
      const chat = await repo.chats.get(chatId)
      if (!chat) return { note: null }
      cancelAsks(chatId, 'The chat was deleted.')
      queued.delete(chatId)
      await manager.dispose(chatId)
      let note: string | null = null
      if (chat.worktreePath && chat.branch && deps.worktrees) {
        const ws = await repo.workspaces.get(chat.workspaceId)
        const r = await deps.worktrees.remove(chat.worktreePath, chat.branch, ws?.path ?? chat.worktreePath)
        note = r.note
      }
      await repo.chats.remove(chatId)
      notify('chats'); notify('messages')
      return { note }
    },

    /** Delete every chat, tidying the safe-to-remove worktrees. Returns how many chats went and any worktrees that were kept. */
    async deleteAllChats(): Promise<{ count: number; kept: string[] }> {
      const kept: string[] = []
      if (deps.worktrees) {
        for (const c of await repo.chats.list()) {
          if (!c.worktreePath || !c.branch) continue
          const ws = await repo.workspaces.get(c.workspaceId)
          const r = await deps.worktrees.remove(c.worktreePath, c.branch, ws?.path ?? c.worktreePath)
          if (r.note) kept.push(r.note)
        }
      }
      await manager.disposeAll()
      const count = await repo.data.deleteAllChats()
      notify('chats'); notify('messages')
      return { count, kept }
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

    /** Save a pasted file (no path on disk) into `.attachments/`. Pasted bytes pass through memory, so these are capped lower than files with a path. */
    async saveFile(chatId: string, name: string, bytes: Uint8Array): Promise<string> {
      if (bytes.byteLength > MAX_PASTED_FILE_BYTES) throw new Error(`pasted files are limited to ${MAX_PASTED_FILE_BYTES / 1024 ** 2} MB; drag the file in instead`)
      const path = join(await uniqueAttachmentDir(chatId), safeFileName(name))
      await writeFile(path, bytes)
      return path
    },

    /** An agent offers a file by path: it must be inside this chat's workspace. Returns what the card needs. */
    async resolveAgentFile(chatId: string, path: string): Promise<{ path: string; bytes: number }> {
      const real = await insideChat(chatId, path)
      const st = await stat(real)
      if (st.isDirectory()) throw new Error('that is a folder; send a file')
      return { path: real, bytes: st.size }
    },

    /** Open a file attachment with its default app, or show it in Finder. Only files inside the chat's workspace. */
    async openAttachmentFile(messageId: string, mode: 'open' | 'reveal' = 'open'): Promise<void> {
      const msg = await repo.messages.get(messageId)
      const a = msg?.kind === 'attachment' ? (msg.body as { path?: string }) : null
      if (!msg || !a?.path) throw new Error('that attachment has no file')
      const real = await insideChat(msg.chatId, a.path)
      if (mode === 'reveal') opener.reveal?.(real)
      else opener.path(real)
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
        const st = await stat(p0)
        if (st.isDirectory()) throw new Error(`${basename(p0)} is a folder. Zip it first and attach the zip.`)
        if (st.size > MAX_FILE_BYTES) throw new Error(`${basename(p0)} is larger than ${MAX_FILE_BYTES / 1024 ** 3} GB`)
        let inline: Awaited<ReturnType<typeof readPickedFile>> | null = null
        if (kindForFile(basename(p0), st.size) !== 'file') inline = await readPickedFile(p0).catch(() => null) // a "text" file that is really binary falls through to a plain file
        if (inline) {
          const m = await repo.messages.append({ chatId, role: 'user', kind: 'attachment', body: { t: 'attachment', id: `u-${Date.now()}-${i}`, kind: inline.kind, name: inline.name, path: p0, body: inline.text }, text: inline.name })
          await repo.attachments.add({ messageId: m.id, kind: inline.kind, name: inline.name, path: p0, body: inline.text })
          parts.push(attachmentPrompt(inline.name, inline.text, lead))
          continue
        }
        const path = await fileInto(chatId, p0)
        const name = basename(p0)
        const m = await repo.messages.append({ chatId, role: 'user', kind: 'attachment', body: { t: 'attachment', id: `u-${Date.now()}-${i}`, kind: 'file', name, path, bytes: st.size }, text: name })
        await repo.attachments.add({ messageId: m.id, kind: 'file', name, path })
        parts.push(filePrompt(name, path, st.size, lead))
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

    /**
     * "Say this next": while the agent works, hold the prompt and send it when the turn ends successfully. Queuing again adds
     * to the held text, so nothing is lost. If the agent is idle the prompt is simply sent.
     */
    async queuePrompt(chatId: string, text: string, quote?: UserTurn['quote']): Promise<{ queued: boolean }> {
      const clean = text.trim()
      if (!clean) return { queued: false }
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      if (chat.status !== 'busy' && chat.status !== 'away') {
        await this.send(chatId, clean, quote)
        return { queued: false }
      }
      const cur = queued.get(chatId)
      queued.set(chatId, { text: cur ? `${cur.text}\n\n${clean}` : clean, quote: cur?.quote ?? quote, held: false })
      notify('queue')
      return { queued: true }
    },

    getQueued(chatId: string): QueuedPrompt | null {
      return queued.get(chatId) ?? null
    },

    /** Take the held prompt back (to edit it, or drop it). Returns its text. */
    takeQueued(chatId: string): string | null {
      const q = queued.get(chatId)
      if (!q) return null
      queued.delete(chatId)
      notify('queue')
      return q.text
    },

    /** Stop the agent now and send the held prompt. */
    async sendQueuedNow(chatId: string): Promise<void> {
      const q = queued.get(chatId)
      if (!q) return
      queued.delete(chatId)
      notify('queue')
      await this.interrupt(chatId)
      await this.send(chatId, q.text, q.quote)
    },

    /** The ingestor calls this when a turn ends: records turn output to the shared board if active, and sends any held prompt. */
    async onTurnEnd(chatId: string, reason: 'done' | 'interrupted' | 'error', participant?: ParticipantTarget, turnText?: string): Promise<void> {
      if (participant && reason === 'done' && turnText && turnText.trim()) {
        await repo.board.append({
          chatId,
          agentId: participant.agentId,
          agentName: participant.displayName,
          entryType: 'TURN',
          summary: sanitizeSingleLine(turnText).slice(0, 200),
          detail: turnText.trim()
        })
        await syncBoardFile(chatId).catch(() => {})
        notify('board')
      } else if (participant) {
        await syncBoardFile(chatId).catch(() => {})
      }
      const q = queued.get(chatId)
      if (!q) return
      // In multi-agent threads, wait until all participants finish before dispatching a queued prompt
      if (participant) {
        const allP = await repo.participants.list(chatId)
        if (allP.some((p) => p.status === 'busy' || p.status === 'away')) return
      }
      if (reason === 'done') {
        queued.delete(chatId)
        notify('queue')
        await this.send(chatId, q.text, q.quote)
      } else {
        q.held = true
        notify('queue')
      }
    },

    /** Invite a Friend (same or different harness/model) into this thread and initialize/sync the shared session board. */
    async inviteParticipant(chatId: string, friendId: string, role?: string, customName?: string): Promise<ChatParticipant> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const friend = await repo.friends.get(friendId)
      if (!friend) throw new Error(`unknown friend ${friendId}`)
      await ensurePrimaryParticipant(chatId)
      const current = await repo.participants.list(chatId)
      const agentId = nextAgentId(friend.harness, current.map((p) => p.agentId))
      const sameFriendCount = current.filter((p) => p.friendId === friendId).length
      const displayName = customName?.trim() || nextParticipantDisplayName(friend.displayName, sameFriendCount)
      const cleanRole = role?.trim() || null
      const added = await repo.participants.add({
        chatId,
        friendId,
        agentId,
        displayName,
        role: cleanRole
      })
      await repo.board.append({
        chatId,
        agentId,
        agentName: displayName,
        entryType: 'INVITE',
        summary: `Invited ${displayName} (${friend.harness})${cleanRole ? ` — role: ${cleanRole}` : ''}`
      })
      const boardPath = await syncBoardFile(chatId)
      const sysText = `Invited ${displayName} [${agentId}]${cleanRole ? ` (${cleanRole})` : ''} to collaborate. Shared board: ${boardPath}`
      await repo.messages.append({
        chatId,
        role: 'system',
        kind: 'system',
        body: { text: sysText },
        text: sysText
      })
      notify('participants')
      notify('board')
      notify('messages')
      return added
    },

    /** Remove a participant from a multi-agent thread and stop its session. */
    async removeParticipant(chatId: string, participantId: string): Promise<void> {
      await manager.dispose(chatId, participantId)
      await repo.participants.remove(participantId)
      await syncBoardFile(chatId).catch(() => {})
      notify('participants')
      notify('board')
    },

    /** Set or update the overall goal at the top of the shared session board file. */
    async setGoal(chatId: string, goal: string | null): Promise<string> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const clean = goal?.trim() || null
      await repo.chats.setGoal(chatId, clean)
      if (clean) await ensurePrimaryParticipant(chatId)
      await repo.board.append({
        chatId,
        agentId: 'user',
        agentName: 'User',
        entryType: 'GOAL',
        summary: clean ? sanitizeSingleLine(clean).slice(0, 200) : 'Cleared overall goal',
        detail: clean && clean.includes('\n') ? clean : null
      })
      const path = await syncBoardFile(chatId)
      notify('chats')
      notify('participants')
      notify('board')
      return path
    },

    /** Append an entry to the shared session board (used by MCP board_append and UI). */
    async appendBoard(
      chatId: string,
      participantId: string | undefined,
      entry: { type?: string; summary: string; detail?: string }
    ): Promise<string> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      let agentId = 'user'
      let agentName = 'User'
      if (participantId) {
        const p =
          (await repo.participants.get(participantId)) ??
          (await repo.participants.list(chatId)).find((x) => x.agentId === participantId) ??
          null
        if (p) {
          agentId = p.agentId
          agentName = p.displayName
        }
      } else {
        const list = await repo.participants.list(chatId)
        if (list[0]) {
          agentId = list[0].agentId
          agentName = list[0].displayName
        } else {
          const f = await repo.friends.get(chat.friendId)
          agentId = nextAgentId(f?.harness ?? 'agent', [])
          agentName = f?.displayName ?? 'Agent'
        }
      }
      const rawType = (entry.type ?? 'STATUS').toUpperCase() as BoardEntryType
      const entryType: BoardEntryType = BOARD_ENTRY_TYPES.includes(rawType) ? rawType : 'STATUS'
      const created = await repo.board.append({
        chatId,
        agentId,
        agentName,
        entryType,
        summary: sanitizeSingleLine(entry.summary),
        detail: entry.detail?.trim() || null
      })
      const path = await syncBoardFile(chatId)
      notify('board')
      return `${formatBoardEntry(created)}\n(Synced to ${path})`
    },

    /** Read or grep the shared session board (used by MCP board_read and UI). */
    async readBoard(
      chatId: string,
      filter: { grep?: string; agentId?: string; type?: string; limit?: number } = {}
    ): Promise<string> {
      const chat = await repo.chats.get(chatId)
      if (!chat) throw new Error(`unknown chat ${chatId}`)
      const path = await syncBoardFile(chatId)
      const roster = await rosterFor(chat)
      const entries = await repo.board.list(chatId, {
        grep: filter.grep,
        agentId: filter.agentId,
        entryType: filter.type,
        limit: filter.limit ?? 50
      })
      const formatted = formatBoardFile({
        chatId: chat.id,
        title: chat.title,
        goal: chat.goal ?? null,
        participants: roster,
        entries
      })
      return `# BOARD_PATH: ${path}\n${formatted}`
    },

    /** Ensure the shared `.boards/<chatId>.log` file exists on disk, open it, and return its path. */
    async openBoard(chatId: string): Promise<string> {
      const path = await syncBoardFile(chatId)
      opener.path(path)
      return path
    },

    /** Return the path to `.boards/<chatId>.log`, syncing it on disk. */
    async getBoardPath(chatId: string): Promise<string> {
      return syncBoardFile(chatId)
    },

    /** Plain stop. */
    async interrupt(chatId: string): Promise<void> {
      cancelAsks(chatId, NO_ANSWER)
      shells.get(chatId)?.kill('SIGINT')
      await manager.interrupt(chatId)
    },

    /** Start a fresh agent session in this chat without losing the transcript history. */
    async reset(chatId: string): Promise<Message | null> {
      const chat = await repo.chats.get(chatId)
      if (!chat) return null
      cancelAsks(chatId, NO_ANSWER)
      shells.get(chatId)?.kill('SIGINT')
      await manager.dispose(chatId)
      await repo.chats.setSession(chatId, null)
      await repo.chats.setStatus(chatId, 'online', null)
      for (const p of await repo.participants.list(chatId)) {
        await repo.participants.setSession(p.id, null)
        await repo.participants.setStatus(p.id, 'online', null)
      }
      const msg = await repo.messages.append({
        chatId,
        role: 'system',
        kind: 'system',
        body: { text: 'Session reset — the next message starts a fresh agent session.' },
        text: 'Session reset — the next message starts a fresh agent session.'
      })
      notify('chats'); notify('participants'); notify('messages')
      return msg
    },

    /** ask_user from the MCP bridge: shows a question card and resolves with the answer. */
    async askUser(chatId: string, prompt: string, choices?: string[], participantId?: string): Promise<string> {
      const reqId = `ask-${randomUUID()}`
      const answered = new Promise<string>((resolve) => asks.set(reqId, { chatId, resolve }))
      let pTarget: ParticipantTarget | undefined
      if (participantId) {
        const p = await repo.participants.get(participantId)
        if (p) pTarget = { id: p.id, agentId: p.agentId, displayName: p.displayName, friendId: p.friendId, harnessSessionId: p.harnessSessionId }
      }
      await ingestor.ingest(chatId, { t: 'question', reqId, prompt, choices }, pTarget)
      return answered
    },

    /** The classic: interrupt whatever the agent is doing, with a transcript line. Rate limited per chat. */
    async nudge(chatId: string, now = Date.now()): Promise<boolean> {
      if (now - (lastNudge.get(chatId) ?? 0) < NUDGE_COOLDOWN_MS) return false
      lastNudge.set(chatId, now)
      const hasShell = shells.has(chatId)
      shells.get(chatId)?.kill('SIGINT')
      const running = hasShell || (manager.isLive(chatId) && (await repo.chats.get(chatId))?.status !== 'online')
      await repo.messages.append({ chatId, role: 'system', kind: 'nudge', body: { interrupted: running }, text: running ? 'You sent a nudge and stopped the agent.' : 'You sent a nudge.' })
      notify('messages')
      cancelAsks(chatId, NO_ANSWER)
      if (manager.isLive(chatId)) void manager.interrupt(chatId).catch(() => {})
      return true
    },

    /** Answer a permission request or question card. */
    async respond(chatId: string, reqId: string, answer: PermDecision | string, reason?: string): Promise<void> {
      await ingestor.idle(chatId)
      const ask = asks.get(reqId)
      const msgs = await repo.messages.list(chatId)
      const card = msgs.find((m) => (m.kind === 'permission' || m.kind === 'question') && (m.body as { reqId?: string }).reqId === reqId)
      let participantId: string | undefined
      if (card) {
        const body = card.body as Record<string, unknown>
        const speaker = body['speaker'] as { participantId?: string } | undefined
        participantId = speaker?.participantId
        await repo.messages.update(card.id, { body: card.kind === 'permission' ? { ...body, decision: answer, reason: reason ?? null } : { ...body, answer } })
      }
      if (participantId) {
        await repo.participants.setStatus(participantId, 'busy', null)
        notify('participants')
      }
      await repo.chats.setStatus(chatId, 'busy', null)
      notify('messages'); notify('chats')
      if (ask) { asks.delete(reqId); ask.resolve(String(answer)); return }
      manager.respond(chatId, reqId, answer, reason, participantId)
    }
  }
}

export type ChatService = ReturnType<typeof createChatService>
