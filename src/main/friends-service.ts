import { execFile, spawn } from 'node:child_process'
import { loginEnv, which } from '../harness/env'
import { RpcPeer } from '../harness/acp/rpc'
import type { Repo } from './db/repo'
import { PRESETS, type DetectedPreset } from '@shared/presets'
import type { Friend } from '@shared/models'

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 6000 }, (err, stdout, stderr) => resolve(err ? null : (stdout || stderr).trim().split('\n')[0] ?? null))
  })

export async function detectPresets(envOverride?: NodeJS.ProcessEnv): Promise<DetectedPreset[]> {
  const env = envOverride ?? (await loginEnv())
  return Promise.all(
    PRESETS.map(async (preset) => {
      const path = which(preset.command, env)
      return { preset, path, version: path ? await run(path, preset.versionArgs, env) : null }
    })
  )
}

/** friend id -> is its CLI runnable right now. Built-ins are always available (handled in shared/grouping). */
export async function availability(friends: Friend[]): Promise<Record<string, boolean>> {
  const env = await loginEnv()
  const out: Record<string, boolean> = {}
  for (const f of friends) {
    if (f.harness === 'asi' || f.harness === 'echo' || f.harness === 'fake') continue
    const command = f.command ?? PRESETS.find((p) => p.id === f.avatar)?.command ?? null
    out[f.id] = command ? which(command, env) !== null : false
  }
  return out
}

export async function addPreset(repo: Repo, presetId: string): Promise<Friend> {
  const preset = PRESETS.find((p) => p.id === presetId)
  if (!preset) throw new Error(`unknown preset ${presetId}`)
  const existing = (await repo.friends.list()).find((f) => f.avatar === preset.id)
  if (existing) return existing
  const env = await loginEnv()
  return repo.friends.create({
    harness: preset.harness, displayName: preset.name, avatar: preset.id, transport: preset.transport,
    command: which(preset.command, env) ?? preset.command, args: preset.args
  })
}

export async function addCustom(repo: Repo, c: { name: string; command: string; args: string[]; kind: 'acp' | 'pty' }): Promise<Friend> {
  const name = c.name.trim()
  if (!name) throw new Error('give your friend a name')
  if (!c.command.trim()) throw new Error('enter the command to run')
  return repo.friends.create({
    harness: c.kind, displayName: name, avatar: null, transport: c.kind === 'acp' ? 'generic' : null,
    command: c.command.trim(), args: c.args
  })
}

/** Starts the command as an ACP agent and reads its handshake. */
export async function testAcp(command: string, args: string[]): Promise<{ ok: true; agent: string } | { ok: false; error: string }> {
  const env = await loginEnv()
  const exe = which(command, env)
  if (!exe) return { ok: false, error: `"${command}" was not found on your PATH` }
  const child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const peer = new RpcPeer(child)
  try {
    const r = await Promise.race([
      peer.request<{ agentInfo?: { name?: string; version?: string } }>('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no ACP handshake within 8s')), 8000))
    ])
    const info = r.agentInfo
    return { ok: true, agent: info?.name ? `${info.name}${info.version ? ' ' + info.version : ''}` : 'ACP agent' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    peer.kill()
  }
}
