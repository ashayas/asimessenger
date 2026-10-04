import type { AcpPreset } from './factory'

/**
 * OpenCode asks for permission only when configured to. In Ask mode we inject a config that
 * makes edits and shell commands prompt; Dangerous mode allows everything.
 */
export const OPENCODE: AcpPreset = {
  command: 'opencode',
  args: ['acp'],
  env: (mode) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: mode === 'dangerous' ? { edit: 'allow', bash: 'allow', webfetch: 'allow' } : mode === 'plan' ? { edit: 'deny', bash: 'ask' } : { edit: 'ask', bash: 'ask', webfetch: 'ask' }
    })
  })
}

export const GEMINI: AcpPreset = {
  command: 'gemini',
  args: ['--experimental-acp'],
  modeArgs: (mode) => (mode === 'dangerous' ? ['--approval-mode', 'yolo'] : mode === 'plan' ? ['--approval-mode', 'plan'] : mode === 'auto-edit' ? ['--approval-mode', 'auto_edit'] : [])
}

/** Hermes and Pi both ship ACP adapters; commands come from the friend's registration. */
export const HERMES: AcpPreset = { command: 'hermes', args: ['acp'] }
export const GENERIC_ACP: AcpPreset = { command: 'acp-agent', args: [] }
