import type { BoardEntry, BoardEntryType } from './models'

export const BOARD_ENTRY_TYPES: readonly BoardEntryType[] = [
  'GOAL',
  'USER',
  'INVITE',
  'CLAIM',
  'STATUS',
  'FINDING',
  'QUESTION',
  'TURN',
  'DONE'
] as const

export function sanitizeSingleLine(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function nextAgentId(harnessOrPrefix: string, existingAgentIds: Iterable<string>): string {
  const base =
    harnessOrPrefix
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  const used = new Set(Array.from(existingAgentIds, (id) => id.toLowerCase()))
  let n = 1
  while (used.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function nextParticipantDisplayName(baseName: string, existingCountForFriend: number): string {
  if (existingCountForFriend <= 0) return baseName
  return `${baseName} #${existingCountForFriend + 1}`
}

export function formatSeq(seq: number): string {
  return String(Math.max(0, seq)).padStart(4, '0')
}

export function formatBoardEntry(e: BoardEntry): string {
  const ts = new Date(e.createdAt).toISOString()
  const seq = formatSeq(e.seq)
  const name = sanitizeSingleLine(e.agentName).replace(/"/g, "'")
  const summary = sanitizeSingleLine(e.summary).replace(/"/g, "'")
  const head = `${ts} | SEQ=${seq} | AGENT=${e.agentId} | NAME="${name}" | TYPE=${e.entryType} | SUMMARY="${summary}"`
  if (!e.detail || !e.detail.trim()) return head
  const detailLines = e.detail
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1))
    .map((line) => `  DETAIL:AGENT=${e.agentId} | SEQ=${seq} | ${line}`)
  return detailLines.length > 0 ? `${head}\n${detailLines.join('\n')}` : head
}

export interface BoardParticipantInfo {
  agentId: string
  displayName: string
  harness?: string
  role: string | null
  status?: string
}

export function formatBoardFile(opts: {
  chatId: string
  title: string
  goal: string | null
  participants: BoardParticipantInfo[]
  entries: BoardEntry[]
}): string {
  const goalText = opts.goal?.trim()
  const goalLines = goalText
    ? goalText.replace(/\r\n/g, '\n').split('\n').map((l) => `# GOAL: ${l.trim()}`)
    : ['# GOAL: (No explicit goal set yet — collaborate on the user request in the log below)']

  const rosterLines =
    opts.participants.length > 0
      ? opts.participants.map((p) => {
          const name = sanitizeSingleLine(p.displayName).replace(/"/g, "'")
          const role = sanitizeSingleLine(p.role ?? 'general').replace(/"/g, "'")
          const harness = sanitizeSingleLine(p.harness ?? 'agent')
          const status = sanitizeSingleLine(p.status ?? 'online')
          return `# AGENT_ROSTER: agent_id=${p.agentId} | name="${name}" | harness=${harness} | role="${role}" | status=${status}`
        })
      : ['# AGENT_ROSTER: (none)']

  const lines: string[] = [
    '# ============================================================================',
    '# ASI MESSENGER SHARED SESSION BOARD (APPEND-ONLY)',
    `# CHAT_ID: ${opts.chatId}`,
    `# CHAT_TITLE: ${sanitizeSingleLine(opts.title)}`,
    '# ============================================================================',
    '# [GOAL]',
    ...goalLines,
    '#',
    '# [AGENTS]',
    ...rosterLines,
    '#',
    '# [GREP_GUIDE]',
    '# Use grep on this file to inspect goals, agent roles, and peer progress:',
    `#   grep "^# GOAL:" <board_file>`,
    `#   grep "^# AGENT_ROSTER:" <board_file>`,
    `#   grep "AGENT=<agent_id>" <board_file>`,
    `#   grep "TYPE=FINDING\\|TYPE=CLAIM\\|TYPE=QUESTION\\|TYPE=DONE" <board_file>`,
    `#   grep "TYPE=TURN" <board_file>`,
    '# ============================================================================',
    '# [LOG]'
  ]

  for (const entry of opts.entries) {
    lines.push(formatBoardEntry(entry))
  }

  return lines.join('\n') + '\n'
}

/**
 * Extracts mentioned participant IDs from `@<agent-id>` tokens in the message.
 * Returns `[]` if `@all` is used or no participant `@<agent-id>` is mentioned.
 */
export function parseTargetMentions(
  text: string,
  participants: { id: string; agentId: string }[]
): string[] {
  const matches = text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)
  const mentioned = new Set<string>()
  for (const m of matches) {
    const token = m[1]?.toLowerCase()
    if (!token) continue
    if (token === 'all') return []
    for (const p of participants) {
      if (p.agentId.toLowerCase() === token) mentioned.add(p.id)
    }
  }
  return Array.from(mentioned)
}

export function buildCollaborationPrompt(opts: {
  boardPath: string
  self: BoardParticipantInfo
  goal: string | null
  participants: BoardParticipantInfo[]
  recentEntries: BoardEntry[]
  userText: string
}): string {
  const goalBlock = opts.goal?.trim()
    ? opts.goal.trim()
    : '(Collaborate on the user request below)'

  const peers = opts.participants
    .map((p) => {
      const tag = p.agentId === opts.self.agentId ? ' [YOU]' : ''
      const role = p.role?.trim() ? ` — role: ${p.role.trim()}` : ''
      const harness = p.harness ? ` (${p.harness})` : ''
      return `- ${p.agentId}: "${p.displayName}"${harness}${role}${tag}`
    })
    .join('\n')

  const recent = opts.recentEntries.slice(-12)
  const recentBlock =
    recent.length > 0
      ? recent.map((e) => formatBoardEntry(e)).join('\n')
      : '(No board entries yet)'

  const selfRoleLine = opts.self.role?.trim() ? `\nYOUR ROLE / FOCUS: ${opts.self.role.trim()}` : ''

  return [
    '[MULTI-AGENT SESSION BOARD CONTEXT]',
    `YOUR AGENT ID: ${opts.self.agentId} ("${opts.self.displayName}")${selfRoleLine}`,
    `OVERALL SESSION GOAL: ${goalBlock}`,
    `SHARED APPEND-ONLY LOG FILE: ${opts.boardPath}`,
    'PARTICIPATING AGENTS:',
    peers,
    'HOW TO COLLABORATE:',
    `1. Search the shared board file with grep to see what other agents have done or found (e.g. \`grep "AGENT=" "${opts.boardPath}"\` or \`grep "TYPE=FINDING\\|TYPE=CLAIM\\|TYPE=TURN" "${opts.boardPath}"\`).`,
    `2. If you have the \`board_append\` / \`board_read\` MCP tools, use \`board_append\` to post CLAIM, STATUS, FINDING, QUESTION, or DONE entries under AGENT=${opts.self.agentId}.`,
    `3. Treat ${opts.boardPath} as strictly APPEND-ONLY with your agent id (${opts.self.agentId}). Never delete or overwrite other agents' entries; your final turn response is also automatically appended to the board.`,
    'RECENT SHARED BOARD ENTRIES:',
    recentBlock,
    '[/MULTI-AGENT SESSION BOARD CONTEXT]',
    '',
    opts.userText
  ].join('\n')
}
