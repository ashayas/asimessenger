import type { Mode } from './models'
import type { Risk } from './events'

export interface SafetyState {
  /** Global switch in Options. Off by default. */
  globalDangerous: boolean
  /** Per-friend opt-in. */
  friendDangerous: boolean
}

export const MODE_LABEL: Record<Mode, string> = { ask: 'Ask', 'auto-edit': 'Auto-edit', plan: 'Plan', dangerous: 'Dangerous' }

/** Dangerous needs BOTH the global switch and the friend's own opt-in. Other modes are always allowed. */
export function canUseMode(mode: Mode, s: SafetyState): boolean {
  return mode !== 'dangerous' || (s.globalDangerous && s.friendDangerous)
}

export function lockedReason(s: SafetyState): string | null {
  if (!s.globalDangerous) return 'Dangerous modes are turned off. Enable them in Options › Safety.'
  if (!s.friendDangerous) return 'This friend has not been allowed to run in dangerous mode. Enable it in Options › Safety.'
  return null
}

const HIGH = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i,
  /\bsudo\b/, /\bmkfs\b/, /\bdd\s+if=/, /:\(\)\s*\{/,
  /\bgit\s+push\b.*(--force|-f\b)/, /\bgit\s+reset\s+--hard\b/, /\bchmod\s+-R\b/, /\bchown\s+-R\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, />\s*\/dev\/(sd|disk)/
]
const MED = [/\bgit\s+push\b/, /\b(npm|pnpm|yarn|bun)\s+(i|install|add|publish)\b/, /\bpip3?\s+install\b/, /\bbrew\s+(install|uninstall)\b/, /\bdocker\b/, /\bkubectl\b/, /\bcurl\b|\bwget\b/, /\brm\b/, /\bmv\b/]

/** Fast local risk estimate for a permission request; the ASI decider (Clef/Jev) refines it when connected. */
export function heuristicRisk(tool: string, summary: string): Risk {
  if (tool === 'exec' || tool === 'Bash' || tool === 'permissions') {
    if (HIGH.some((r) => r.test(summary))) return 'high'
    if (tool === 'permissions' || MED.some((r) => r.test(summary))) return 'med'
    return 'low'
  }
  if (tool === 'edit' || /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    return /(^|\/)(\.env|\.ssh|\.git\/|id_rsa|credentials|\.npmrc|\.zshrc|\.bashrc)/.test(summary) || summary.startsWith('/etc') || summary.startsWith('~') ? 'high' : 'low'
  }
  return 'med'
}
