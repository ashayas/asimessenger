import type { AttachmentKind } from './events'

export const MAX_ATTACH_BYTES = 200 * 1024
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** The mime type for a picture file name, or null when it is not one of the formats agents accept. */
export function imageMime(name: string): string | null {
  return IMAGE_MIME[name.toLowerCase().split('.').pop() ?? ''] ?? null
}

/** Safe file name for a pasted or dropped picture saved into the workspace. */
export function safeImageName(name: string, now = Date.now()): string {
  const ext = (name.toLowerCase().split(/[\\/]/).pop()!.split('.').pop() ?? '').replace(/[^a-z]/g, '')
  const base = name.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]*$/, '').replace(/^\.+/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image'
  return `${stem}-${now}.${IMAGE_MIME[ext] ? ext : 'png'}`
}

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'zsh', 'bash', 'sql', 'json', 'yaml', 'yml', 'toml', 'css', 'html', 'xml', 'lua', 'zig', 'txt', 'log'])

/** Files sent as-is can be large; this only stops something unreasonable (copying 20 GB into a workspace). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
/** A pasted file has no path, so its bytes pass through memory: keep that modest. */
export const MAX_PASTED_FILE_BYTES = 100 * 1024 * 1024

/**
 * What kind of attachment card a file should become. Small text the app can show (markdown, code, diffs) opens in the viewer and is
 * read by the agent inline; everything else (csv, spreadsheets, PDFs, archives, big text) is a plain `file`.
 */
export function kindForFile(name: string, bytes = 0): AttachmentKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (imageMime(name)) return 'image'
  if (bytes > MAX_ATTACH_BYTES) return 'file'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'diff' || ext === 'patch') return 'diff'
  if (CODE.has(ext)) return 'code'
  return 'file'
}

export function badgeFor(kind: AttachmentKind, name = ''): string {
  if (kind === 'file') return fileBadge(name)
  return kind === 'markdown' ? 'MD' : kind === 'diff' ? 'Δ' : kind === 'image' ? 'IMG' : kind === 'plan' ? 'PLAN' : 'CODE'
}

/** The extension in capitals for a file icon: CSV, XLSX, PDF. */
export function fileBadge(name: string): string {
  const ext = name.includes('.') ? (name.toLowerCase().split('.').pop() ?? '') : ''
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE'
}

/** 1.4 KB, 23 MB, 1.2 GB */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

/** Safe name for a file copied into the workspace's .attachments folder: same extension; add `now` to make the name unique on its own. */
export function safeFileName(name: string, now?: number): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) : ''
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/^\.+/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file'
  return `${stem}${now === undefined ? '' : `-${now}`}${ext ? `.${ext}` : ''}`
}

/** Text for the agent when you send it a picture. The path lets agents without native image input open it. */
export function imagePrompt(name: string, path: string, note: string): string {
  return `${note ? note + '\n\n' : ''}I'm attaching a picture, ${name}, saved at ${path}. Please look at it.`
}

/** Text for the agent when you send it a file it should open itself: where it is, how big, and what to do. */
export function filePrompt(name: string, path: string, bytes: number, note: string): string {
  return `${note ? note + '\n\n' : ''}I'm attaching a file, ${name} (${fmtBytes(bytes)}), saved at ${path}. Please open it from there and use its contents.`
}

/** Text for the agent when you send it a file. */
export function attachmentPrompt(name: string, content: string, note: string): string {
  const fence = content.includes('```') ? '~~~~' : '```'
  return `${note ? note + '\n\n' : ''}I'm attaching ${name}:\n\n${fence}\n${content}\n${fence}`
}
