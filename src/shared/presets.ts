import type { HarnessKind } from './models'

export interface FriendPreset {
  id: string
  name: string
  harness: HarnessKind
  /** For ACP friends: which built-in preset adapter to use. */
  transport: string | null
  command: string
  args: string[]
  versionArgs: string[]
  installHint: string
  blurb: string
}

/** One-click friends. Detection looks for `command` on your login-shell PATH. */
export const PRESETS: FriendPreset[] = [
  { id: 'claude', name: 'Claude Code', harness: 'claude', transport: null, command: 'claude', args: [], versionArgs: ['--version'], installHint: 'curl -fsSL https://claude.ai/install.sh | bash', blurb: 'native stream-json' },
  { id: 'codex', name: 'Codex', harness: 'codex', transport: null, command: 'codex', args: [], versionArgs: ['--version'], installHint: 'npm i -g @openai/codex', blurb: 'app-server' },
  { id: 'opencode', name: 'OpenCode', harness: 'acp', transport: 'opencode', command: 'opencode', args: ['acp'], versionArgs: ['--version'], installHint: 'curl -fsSL https://opencode.ai/install | bash', blurb: 'ACP' },
  { id: 'gemini', name: 'Gemini CLI', harness: 'acp', transport: 'gemini', command: 'gemini', args: ['--experimental-acp'], versionArgs: ['--version'], installHint: 'npm i -g @google/gemini-cli', blurb: 'ACP · sign in once in a terminal' },
  { id: 'hermes', name: 'Hermes', harness: 'acp', transport: 'hermes', command: 'hermes', args: ['acp'], versionArgs: ['--version'], installHint: 'see the Hermes Agent docs', blurb: 'ACP' },
  { id: 'pi', name: 'Pi', harness: 'acp', transport: 'generic', command: 'pi-acp', args: [], versionArgs: ['--version'], installHint: 'install an ACP adapter for Pi, then set its command here', blurb: 'ACP adapter' }
]

export interface DetectedPreset {
  preset: FriendPreset
  path: string | null
  version: string | null
}
