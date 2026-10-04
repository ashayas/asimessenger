import { PtySession } from './session'
import { loginEnv, which } from '../env'
import type { HarnessFactory } from '../types'

export const ptyFactory: HarnessFactory = async (ctx) => {
  const env = await loginEnv()
  const command = ctx.friend.command
  if (!command) throw new Error('this friend has no command to run')
  const exe = which(command, env)
  if (!exe) throw new Error(`"${command}" was not found on your PATH`)
  return new PtySession({ command: exe, args: ctx.friend.args, cwd: ctx.cwd, env })
}
