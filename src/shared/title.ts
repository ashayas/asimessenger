/** Where a chat's title came from. A title you typed yourself is never replaced. */
export type TitleSource = 'default' | 'rule' | 'model' | 'agent' | 'user'

const RANK: Record<TitleSource, number> = { default: 0, rule: 1, model: 2, agent: 3, user: 4 }

/** A better source may replace a worse one; nothing replaces your own title. */
export function canReplaceTitle(current: TitleSource, next: TitleSource): boolean {
  return current !== 'user' && RANK[next] >= RANK[current]
}

export const TITLE_MAX = 42
const FILLER = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|well|please|pls|just|quick(?:ly)?|also|and|then)\b|(?:can|could|would|will)\s+you\b|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\b|i'd\s+like\s+(?:you\s+)?to\b|let'?s\b|help\s+me(?:\s+to)?\b|go\s+ahead\s+and\b)[\s,:;.!-]*/i

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** A quick offline title from your first message: first line, filler words dropped, first sentence, cut on a word boundary. */
export function ruleTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('```')) ?? ''
  const flat = line.replace(/\s+/g, ' ').trim()
  let core = flat
  for (let i = 0; i < 4; i++) {
    const next = core.replace(FILLER, '')
    if (next === core) break
    core = next
  }
  if (words(core) < 2) core = flat // "hello there" stays "hello there"
  const sentence = core.split(/(?<=[.!?])\s/)[0] ?? core
  const trimmed = sentence.replace(/[\s.!?,;:]+$/, '')
  return clip(trimmed || flat, TITLE_MAX)
}

/** Tidy a title written by an agent or a model: one line, no quotes or label, sensible length. */
export function cleanTitle(raw: string, max = 60): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const t = line.replace(/^(?:title|chat title)\s*[:-]\s*/i, '').replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s]+$/g, '').replace(/[.!]+$/, '').replace(/\s+/g, ' ')
  return clip(t, max)
}
