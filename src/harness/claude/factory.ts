import { ClaudeSession } from './session'
import { loginEnv, which } from '../env'
import type { HarnessFactory } from '../types'

export const claudeFactory: HarnessFactory = async (ctx) => {
  const env = await loginEnv()
  const command = ctx.friend.command ?? 'claude'
  const exe = which(command, env)
  if (!exe) throw new Error(`"${command}" was not found on your PATH`)
  if (ctx.mode === 'dangerous' && !ctx.friend.dangerousAllowed) throw new Error('dangerous mode is not enabled for this friend')
  return new ClaudeSession({
    command: exe, env, cwd: ctx.cwd, mode: ctx.mode,
    dangerousAllowed: ctx.friend.dangerousAllowed, resumeId: ctx.resumeId, extraArgs: ctx.friend.args
  })
}
