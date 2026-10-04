import type { Chat, Friend } from './models'

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The shell command that continues this chat's agent session in a normal terminal, or null if we do not know how. */
export function resumeCommand(friend: Pick<Friend, 'harness' | 'transport' | 'command' | 'avatar'>, chat: Pick<Chat, 'harnessSessionId'>, cwd: string): string | null {
  const id = chat.harnessSessionId
  const bin = friend.command ? q(friend.command) : null
  let cmd: string | null = null
  if (friend.harness === 'claude') cmd = `${bin ?? 'claude'}${id ? ` --resume ${q(id)}` : ''}`
  else if (friend.harness === 'codex') cmd = `${bin ?? 'codex'}${id ? ` resume ${q(id)}` : ''}`
  else if (friend.harness === 'pi') cmd = `${bin ?? 'pi'}${id ? ` --session ${q(id)}` : ''}`
  else if (friend.harness === 'acp' && friend.transport === 'opencode') cmd = `${bin ?? 'opencode'}${id ? ` --session ${q(id)}` : ''}`
  else if (friend.harness === 'pty' && bin) cmd = bin
  return cmd ? `cd ${q(cwd)} && ${cmd}` : null
}
