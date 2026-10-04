import { CodexSession } from './session'
import { loginEnv, which } from '../env'
import type { HarnessFactory } from '../types'

export const codexFactory: HarnessFactory = async (ctx) => {
  const env = await loginEnv()
  const command = ctx.friend.command ?? 'codex'
  const exe = which(command, env)
  if (!exe) throw new Error(`"${command}" was not found on your PATH`)
  if (ctx.mode === 'dangerous' && !ctx.friend.dangerousAllowed) throw new Error('dangerous mode is not enabled for this friend')
  return CodexSession.create({ command: exe, env, cwd: ctx.cwd, mode: ctx.mode, resumeId: ctx.resumeId, extraArgs: ctx.friend.args, mcp: ctx.mcp })
}
