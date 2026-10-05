import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, sep } from 'node:path'
import type { Repo } from './db/repo'
import { MAX_ATTACH_BYTES, kindForFile } from '@shared/attachments'
import type { AttachmentKind } from '@shared/events'

export interface LoadedAttachment {
  chatId: string
  name: string
  kind: AttachmentKind
  text: string
  path: string | null
  friendName: string
}

/** Agents may point at files; we only ever read ones inside the chat's workspace. */
export async function readInsideWorkspace(path: string, workspace: string): Promise<string> {
  const [real, root] = await Promise.all([realpath(path), realpath(workspace)])
  if (real !== root && !real.startsWith(root + sep)) throw new Error('that file is outside this workspace')
  const st = await stat(real)
  if (st.size > MAX_ATTACH_BYTES) throw new Error(`file is larger than ${MAX_ATTACH_BYTES / 1024} KB`)
  return readFile(real, 'utf8')
}

/** Images come back as a data URL so the viewer needs no file access. */
export async function readImageInsideWorkspace(path: string, workspace: string): Promise<string> {
  const [real, root] = await Promise.all([realpath(path), realpath(workspace)])
  if (real !== root && !real.startsWith(root + sep)) throw new Error('that file is outside this workspace')
  const st = await stat(real)
  if (st.size > 10 * 1024 * 1024) throw new Error('image is larger than 10 MB')
  const ext = real.toLowerCase().split('.').pop()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${(await readFile(real)).toString('base64')}`
}

export async function loadAttachment(repo: Repo, messageId: string): Promise<LoadedAttachment> {
  const msg = await repo.messages.get(messageId)
  if (!msg || msg.kind !== 'attachment') throw new Error('attachment not found')
  const a = msg.body as { name: string; kind: AttachmentKind; body?: string; path?: string }
  const chat = await repo.chats.get(msg.chatId)
  const friend = chat ? await repo.friends.get(chat.friendId) : null
  let text = a.body ?? ''
  if (!text && a.path) {
    const ws = chat ? await repo.workspaces.get(chat.workspaceId) : null
    // an isolated chat's files live in its worktree; its workspace folder is still a valid place to point at
    const roots = [chat?.worktreePath, ws?.path].filter((r): r is string => !!r)
    let last: unknown = new Error('that file is outside this workspace')
    for (const root of roots.length ? roots : ['/nonexistent']) {
      try { text = a.kind === 'image' ? await readImageInsideWorkspace(a.path, root) : await readInsideWorkspace(a.path, root); last = null; break } catch (e) { last = e }
    }
    if (last) throw last
  }
  return { chatId: msg.chatId, name: a.name, kind: a.kind, text, path: a.path ?? null, friendName: friend?.displayName ?? 'Agent' }
}

/** Reads a user-picked file for sending. Any readable text file under the size cap. */
export async function readPickedFile(path: string): Promise<{ name: string; text: string; kind: AttachmentKind }> {
  const st = await stat(path)
  if (st.size > MAX_ATTACH_BYTES) throw new Error(`${basename(path)} is larger than ${MAX_ATTACH_BYTES / 1024} KB`)
  const buf = await readFile(path)
  if (buf.includes(0)) throw new Error(`${basename(path)} looks like a binary file`)
  return { name: basename(path), text: buf.toString('utf8'), kind: kindForFile(path) }
}
