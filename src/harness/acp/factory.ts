import { spawn } from 'node:child_process'
import { RpcFailure, RpcPeer } from './rpc'
import { AcpSession, type AcpSessionOptions } from './session'
import { loginEnv, which } from '../env'
import type { HarnessFactory, SessionContext } from '../types'
import type { Mode } from '@shared/models'

export interface AcpPreset {
  /** Default executable when the friend has no explicit command. */
  command: string
  args: string[]
  /** Extra environment for the session (e.g. permission policy for the chosen mode). */
  env?(mode: Mode): Record<string, string>
  /** Extra args for the chosen mode. */
  modeArgs?(mode: Mode): string[]
  session?: AcpSessionOptions
}

const MODE_NOT_ALLOWED = 'dangerous mode is not enabled for this friend'

export function acpFactory(preset: AcpPreset): HarnessFactory {
  return async (ctx: SessionContext) => {
    if (ctx.mode === 'dangerous' && !ctx.friend.dangerousAllowed) throw new Error(MODE_NOT_ALLOWED)
    const env = { ...(await loginEnv()), ...(preset.env?.(ctx.mode) ?? {}) }
    const command = ctx.friend.command ?? preset.command
    const exe = which(command, env)
    if (!exe) throw new Error(`"${command}" was not found on your PATH`)
    const args = [...(ctx.friend.args.length ? ctx.friend.args : preset.args), ...(preset.modeArgs?.(ctx.mode) ?? [])]
    const child = spawn(exe, args, { cwd: ctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const peer = new RpcPeer(child)
    try {
      const init = await peer.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      })
      let sessionId: string
      let session: AcpSession | null = null
      if (ctx.resumeId && init.agentCapabilities?.loadSession) {
        try {
          sessionId = ctx.resumeId
          session = new AcpSession(peer, sessionId, preset.session)
          session.setSuppress(true) // history is replayed as updates; we already have it
          await peer.request('session/load', { sessionId, cwd: ctx.cwd, mcpServers: [] })
          session.setSuppress(false)
        } catch {
          session = null // fall through to a fresh session
        }
      }
      if (!session) {
        const r = await peer.request<{ sessionId: string }>('session/new', { cwd: ctx.cwd, mcpServers: [] })
        sessionId = r.sessionId
        session = new AcpSession(peer, sessionId, preset.session)
      }
      session.setMode(ctx.mode)
      return session
    } catch (err) {
      peer.kill()
      const msg = err instanceof RpcFailure ? err.rpc.message : err instanceof Error ? err.message : String(err)
      if (/auth|consent|login|sign/i.test(msg)) throw new Error(`${command} needs you to sign in. Run \`${command}\` once in a terminal, then try again. (${msg.split('\n')[0]})`, { cause: err })
      throw new Error(msg, { cause: err })
    }
  }
}
