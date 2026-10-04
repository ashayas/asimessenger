import type { HarnessKind } from './models'

export interface AvatarStyle {
  label: string
  gradient: [string, string]
}

const KNOWN: Record<string, AvatarStyle> = {
  claude: { label: 'C', gradient: ['#d97757', '#b85a3c'] },
  codex: { label: 'Cx', gradient: ['#2b2b2b', '#5a5a5a'] },
  opencode: { label: 'oc', gradient: ['#3d3d52', '#6a6a8c'] },
  gemini: { label: 'G', gradient: ['#4285f4', '#9b72cb'] },
  hermes: { label: 'H', gradient: ['#7b5ea7', '#b39ddb'] },
  pi: { label: 'π', gradient: ['#7b8794', '#a9b3be'] },
  asi: { label: '✦', gradient: ['#1a43b8', '#4f9ee8'] },
  echo: { label: 'E', gradient: ['#2f9e6b', '#7fd1a8'] },
  http: { label: 'H', gradient: ['#39594d', '#6f9b84'] },
  me: { label: 'A', gradient: ['#e05297', '#f39ac2'] }
}

const FALLBACK: AvatarStyle = { label: '?', gradient: ['#6b7a99', '#a4b0c8'] }

/** Avatar style for a friend: explicit avatar key first, then harness kind, then the first letter of the name. */
export function avatarFor(friend: { avatar: string | null; harness: HarnessKind; displayName: string }): AvatarStyle {
  const hit = (friend.avatar && KNOWN[friend.avatar]) || KNOWN[friend.harness]
  if (hit && friend.harness !== 'pty' && friend.harness !== 'acp') return hit
  if (friend.avatar && KNOWN[friend.avatar]) return KNOWN[friend.avatar]!
  return { label: friend.displayName.slice(0, 1).toUpperCase() || FALLBACK.label, gradient: FALLBACK.gradient }
}
