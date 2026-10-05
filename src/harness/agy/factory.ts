import { AgySession } from './session'
import { loginEnv, which } from '../env'
import type { HarnessFactory } from '../types'

export const agyFactory: HarnessFactory = async (ctx) => {
  const env = await loginEnv()
  const command = ctx.friend.command ?? 'agy'
  const exe = which(command, env)
  if (!exe) throw new Error(`"${command}" was not found on your PATH (install Antigravity CLI, then run agy once to sign in)`)
  const base = { command: exe, env, cwd: ctx.cwd, mode: ctx.mode, dangerousAllowed: ctx.friend.dangerousAllowed, extraArgs: ctx.friend.args }
  if (ctx.resumeId) {
    // a conversation that no longer exists (or an old id from another agent) must not block the chat: start a fresh one
    try { return await AgySession.create({ ...base, resumeId: ctx.resumeId }) } catch { /* fall through */ }
  }
  return AgySession.create(base)
}
