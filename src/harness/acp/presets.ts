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
      permission: mode === 'dangerous' ? { '*': 'allow' } : mode === 'plan' ? { edit: 'deny', bash: 'ask' } : mode === 'auto-edit' ? { edit: 'allow', bash: 'ask', webfetch: 'ask' } : { edit: 'ask', bash: 'ask', webfetch: 'ask' }
    })
  })
}

/** Hermes and Pi both ship ACP adapters; commands come from the friend's registration. */
export const HERMES: AcpPreset = { command: 'hermes', args: ['acp'] }
export const GENERIC_ACP: AcpPreset = { command: 'acp-agent', args: [] }
