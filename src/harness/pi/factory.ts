import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PiSession } from './session'
import { loginEnv, which } from '../env'
import type { HarnessFactory } from '../types'

let extensionPath = ''
/** The main process points this at the bundled ASI extension (asar-unpacked in a packaged app). */
export function configurePi(o: { extensionPath: string }): void {
  extensionPath = o.extensionPath
}

export const piFactory: HarnessFactory = async (ctx) => {
  const env = await loginEnv()
  const command = ctx.friend.command ?? 'pi'
  const exe = which(command, env)
  if (!exe) throw new Error(`"${command}" was not found on your PATH`)
  if (ctx.mode === 'dangerous' && !ctx.friend.dangerousAllowed) throw new Error('dangerous mode is not enabled for this friend')
  if (!extensionPath) throw new Error('the ASI extension for Pi is not configured')
  // sessions live where `pi -r` finds them, so a chat can always be continued in a terminal
  const dir = join(homedir(), '.pi', 'agent', 'sessions', 'asi-messenger')
  mkdirSync(dir, { recursive: true })
  return new PiSession({
    command: exe, env, cwd: ctx.cwd, mode: ctx.mode, dangerousAllowed: ctx.friend.dangerousAllowed,
    sessionFile: ctx.resumeId || join(dir, `${randomUUID()}.jsonl`), extensionPath, extraArgs: ctx.friend.args, mcp: ctx.mcp
  })
}
