import type { Phase, ToolKind } from './events'

export type Lettering = 'funky' | 'plain'

const SMALL_CAPS: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ',
  n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ'
}
export const smallCaps = (t: string): string => [...t.toLowerCase()].map((c) => SMALL_CAPS[c] ?? c).join('')

const short = (s: string, n = 44): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** What a command is *for*, in two or three words. */
export function describeCommand(cmd: string): string {
  const c = cmd.trim()
  if (/\b(vitest|jest|pytest|mocha|rspec)\b|\b(go|cargo|npm|pnpm|yarn|bun|swift)\s+test\b|\bplaywright\s+test\b/.test(c)) return 'running tests'
  if (/\b(npm|pnpm|yarn|bun|pip3?|brew|cargo|go)\s+(i|install|add|get)\b/.test(c)) return 'installing'
  if (/\b(build|compile|tsc|webpack|vite\s+build|cargo\s+build|make)\b/.test(c)) return 'building'
  if (/\b(lint|eslint|prettier|ruff|clippy)\b/.test(c)) return 'linting'
  if (/^git\s+/.test(c)) return `git ${c.split(/\s+/)[1] ?? ''}`.trim()
  return `running ${short(c.split(/\s+/)[0] ?? c, 18)}`
}

export interface StatusInput {
  phase: Phase | 'stopped'
  detail?: string
  kind?: ToolKind
}

/** Plain words describing what the agent is doing. Safe for screen readers and the plain lettering style. */
export function statusPlain(i: StatusInput): string {
  const d = i.detail ? short(i.detail) : ''
  switch (i.phase) {
    case 'idle': return 'ready'
    case 'thinking': return 'thinking…'
    case 'tool':
      if (i.kind === 'exec') return `${describeCommand(i.detail ?? '')}${/^(running tests|installing|building|linting)$/.test(describeCommand(i.detail ?? '')) && d ? ` · ${d}` : ''}`
      if (i.kind === 'edit') return `editing ${d}`.trim()
      if (i.kind === 'read') return `reading ${d}`.trim()
      if (i.kind === 'search') return `searching ${d}`.trim()
      if (i.kind === 'web') return `browsing ${d}`.trim()
      return d ? `using ${d}` : 'working…'
    case 'waiting': return d === 'question' ? 'has a question for you' : `waiting on you: ${d}`.replace(/: $/, '')
    case 'done': return 'done'
    case 'stopped': return 'stopped'
    case 'error': return `crashed${d ? `: ${d}` : ''}`
  }
}

/** The status line shown under a friend's name, in the chosen lettering. */
export function statusLine(i: StatusInput, style: Lettering = 'funky'): string {
  const plain = statusPlain(i)
  if (style === 'plain') return plain
  switch (i.phase) {
    case 'idle': return plain
    case 'thinking': return '.｡o○ thinking…'
    case 'tool': {
      const [label, ...rest] = plain.split(' · ')
      const tail = rest.length ? ` ${rest.join(' · ')}` : ''
      if (i.kind === 'exec') return `✧ ${smallCaps(label ?? '')} ✧${tail}`
      if (i.kind === 'edit') return `~*~ ${plain} ~*~`
      if (i.kind === 'read' || i.kind === 'search') return `🔍 ${smallCaps(plain)}`
      return `✧ ${plain} ✧`
    }
    case 'waiting': return i.detail === 'question' ? '❓ has a question 4 u' : `(⊙_⊙) ${plain.replace('waiting on you', 'waiting on u')}`
    case 'done': return '★彡 done 彡★'
    case 'stopped': return '✋ stopped'
    case 'error': return `x_x ${plain}`
  }
}
