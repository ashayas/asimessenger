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

/** What kind of attachment card a file name should become. */
export function kindForFile(name: string): AttachmentKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'diff' || ext === 'patch') return 'diff'
  if (imageMime(name)) return 'image'
  if (CODE.has(ext)) return 'code'
  return 'code'
}

export function badgeFor(kind: AttachmentKind): string {
  return kind === 'markdown' ? 'MD' : kind === 'diff' ? 'Δ' : kind === 'image' ? 'IMG' : kind === 'plan' ? 'PLAN' : 'CODE'
}

/** Text for the agent when you send it a picture. The path lets agents without native image input open it. */
export function imagePrompt(name: string, path: string, note: string): string {
  return `${note ? note + '\n\n' : ''}I'm attaching a picture, ${name}, saved at ${path}. Please look at it.`
}

/** Text for the agent when you send it a file. */
export function attachmentPrompt(name: string, content: string, note: string): string {
  const fence = content.includes('```') ? '~~~~' : '```'
  return `${note ? note + '\n\n' : ''}I'm attaching ${name}:\n\n${fence}\n${content}\n${fence}`
}
