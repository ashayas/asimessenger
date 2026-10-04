import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

let cached: Promise<NodeJS.ProcessEnv> | null = null

/**
 * A GUI-launched app does not inherit your shell PATH (Homebrew, nvm, ~/.local/bin ...).
 * Ask the login shell for its environment once and merge it over process.env.
 */
export function loginEnv(): Promise<NodeJS.ProcessEnv> {
  if (cached) return cached
  cached = new Promise((resolve) => {
    const shell = process.env['SHELL'] || '/bin/zsh'
    const marker = '__ASI_ENV__'
    execFile(shell, ['-ilc', `printf '${marker}'; env -0`], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.includes(marker)) return resolve({ ...process.env })
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const entry of stdout.split(marker).pop()!.split('\0')) {
        const i = entry.indexOf('=')
        if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1)
      }
      resolve(env)
    })
  })
  return cached
}

export function resetLoginEnvCache(): void {
  cached = null
}

/** Resolve a command name to an absolute executable path using the given environment's PATH. */
export function which(cmd: string, env: NodeJS.ProcessEnv): string | null {
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const full = join(dir, cmd)
    if (isExecutable(full)) return full
  }
  return null
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}
