import type { AttachmentKind } from './events'

export const MAX_ATTACH_BYTES = 200 * 1024

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'zsh', 'bash', 'sql', 'json', 'yaml', 'yml', 'toml', 'css', 'html', 'xml', 'lua', 'zig', 'txt', 'log'])

/** What kind of attachment card a file name should become. */
export function kindForFile(name: string): AttachmentKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'diff' || ext === 'patch') return 'diff'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image'
  if (CODE.has(ext)) return 'code'
  return 'code'
}

export function badgeFor(kind: AttachmentKind): string {
  return kind === 'markdown' ? 'MD' : kind === 'diff' ? 'Δ' : kind === 'image' ? 'IMG' : kind === 'plan' ? 'PLAN' : 'CODE'
}

/** Text for the agent when you send it a file. */
export function attachmentPrompt(name: string, content: string, note: string): string {
  const fence = content.includes('```') ? '~~~~' : '```'
  return `${note ? note + '\n\n' : ''}I'm attaching ${name}:\n\n${fence}\n${content}\n${fence}`
}
