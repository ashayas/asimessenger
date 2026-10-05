import { spawn } from 'node:child_process'
import { RpcPeer } from '../harness/acp/rpc'
import { mapClaudeRateLimit } from '../harness/claude/limits'
import { mapCodexRateLimits } from '../harness/codex/limits'
import type { AgentEvent } from '@shared/events'
import type { UsageOverview } from '@shared/usage'

type Obj = Record<string, unknown>
type LimitsEvent = Extract<AgentEvent, { t: 'limits' }>

export interface ProbeOptions {
  command: string
  env: NodeJS.ProcessEnv
  /** Arguments placed before the real ones; tests run a node script through this. */
  prefixArgs?: string[]
  timeoutMs?: number
}

export type CodexAccount = NonNullable<UsageOverview['codexAccount']>

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Ask Codex about the whole account without starting a chat: subscription windows and lifetime/daily tokens.
 * Costs nothing (no model call) and includes work done outside this app.
 */
export async function probeCodex(o: ProbeOptions, nowMs = Date.now()): Promise<{ limits: LimitsEvent | null; account: CodexAccount | null }> {
  const child = spawn(o.command, [...(o.prefixArgs ?? []), 'app-server'], { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const peer = new RpcPeer(child, { jsonrpcField: false })
  const timer = setTimeout(() => peer.kill(), o.timeoutMs ?? 20_000)
  try {
    await peer.request('initialize', { clientInfo: { name: 'asi-messenger', title: 'ASI Messenger', version: '0.1.0' }, capabilities: null })
    peer.notify('initialized')
    const [rl, usage] = await Promise.all([
      peer.request<Obj>('account/rateLimits/read', null).catch(() => null),
      peer.request<Obj>('account/usage/read', null).catch(() => null)
    ])
    const limits = rl ? mapCodexRateLimits(rl['rateLimits'] as Obj) : null
    let account: CodexAccount | null = null
    const summary = usage?.['summary'] as Obj | undefined
    if (summary && typeof summary['lifetimeTokens'] === 'number') {
      const buckets = new Map(((usage?.['dailyUsageBuckets'] as Obj[]) ?? []).map((b) => [String(b['startDate']), Number(b['tokens'] ?? 0)]))
      const last14: { day: string; tokens: number }[] = []
      for (let i = 13; i >= 0; i--) { const d = new Date(nowMs); d.setDate(d.getDate() - i); const day = dayKey(d); last14.push({ day, tokens: buckets.get(day) ?? 0 }) }
      account = { lifetimeTokens: Number(summary['lifetimeTokens']), peakDailyTokens: Number(summary['peakDailyTokens'] ?? 0), last14, asOf: nowMs }
    }
    if (!limits && !account) throw new Error('Codex did not report usage (is it signed in?)')
    return { limits, account }
  } finally {
    clearTimeout(timer)
    peer.kill()
  }
}

/**
 * Claude only reports its subscription windows while it answers something, so a refresh sends one tiny request to the
 * cheapest model. It returns the limits and what the request itself cost.
 */
export async function probeClaude(o: ProbeOptions): Promise<{ limits: LimitsEvent; usage: Extract<AgentEvent, { t: 'usage' }> | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.command, [...(o.prefixArgs ?? []), '-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence', 'Reply with: ok'], { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let limits: LimitsEvent | null = null
    let usage: Extract<AgentEvent, { t: 'usage' }> | null = null
    let buf = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude did not answer in time')) }, o.timeoutMs ?? 60_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        try {
          const m = JSON.parse(line) as Obj
          if (m['type'] === 'rate_limit_event') limits = mapClaudeRateLimit((m['rate_limit_info'] ?? {}) as Obj) ?? limits
          if (m['type'] === 'result') {
            const u = (m['usage'] ?? {}) as Obj
            usage = { t: 'usage', inputTokens: Number(u['input_tokens'] ?? 0), outputTokens: Number(u['output_tokens'] ?? 0), cacheReadTokens: Number(u['cache_read_input_tokens'] ?? 0), cacheWriteTokens: Number(u['cache_creation_input_tokens'] ?? 0), costUsd: typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : undefined }
          }
        } catch { /* not JSON */ }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { err = (err + d).slice(-500) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer)
      if (limits) resolve({ limits, usage })
      else reject(new Error(err.trim().split('\n').pop() || 'Claude did not report its limits (is it signed in with a subscription?)'))
    })
  })
}
