import type { Repo } from '../main/db/repo'
import type { Secrets } from '../main/secrets'
import { clefDecider, type Decider } from './decider'

export interface BrainConfig {
  provider: 'clef'
  accountId: string
  model: 'clef' | 'clef-flash'
}

const PRICE_PER_M: Record<BrainConfig['model'], number> = { 'clef-flash': 0.09, clef: 0.24 }
const TOKEN = 'cloudflare-token'

export interface BrainStatus {
  connected: boolean
  model?: BrainConfig['model']
  accountId?: string
}

const mask = (id: string) => (id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)

/** ASI's decision model: Cloudflare Clef. Credentials live in the keychain; the account id is shown masked. */
export function createBrain(repo: Repo, secrets: Secrets, fetchImpl?: typeof fetch, baseUrl?: string) {
  return {
    async status(): Promise<BrainStatus> {
      const cfg = await repo.settings.get<BrainConfig | null>('asi.brain', null)
      if (!cfg || !(await secrets.has(TOKEN))) return { connected: false }
      return { connected: true, model: cfg.model, accountId: mask(cfg.accountId) }
    },
    /** The decider to use right now, or null (offline heuristics) when not connected. */
    async decider(): Promise<Decider | null> {
      const cfg = await repo.settings.get<BrainConfig | null>('asi.brain', null)
      const token = await secrets.get(TOKEN)
      return cfg && token ? clefDecider({ accountId: cfg.accountId, token, model: cfg.model, fetchImpl, baseUrl }) : null
    },
    /** Validates with one real decision, then stores. Nothing is saved on failure. */
    async connect(input: { accountId: string; token: string; model: BrainConfig['model'] }): Promise<{ latencyMs: number; costPerDecisionUsd: number }> {
      const accountId = input.accountId.trim()
      const token = input.token.trim()
      if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('a Cloudflare account ID is 32 hex characters (dashboard › Workers & Pages › right sidebar)')
      if (token.length < 20) throw new Error('paste an API token with the “Workers AI” permission')
      const d = clefDecider({ accountId, token, model: input.model, fetchImpl, baseUrl, timeoutMs: 10_000 })
      const t0 = Date.now()
      try {
        await d.decide('ASI Messenger connection test', { ok: { type: 'noul', instructions: 'Is this a test message?' } })
      } catch (e) {
        throw new Error(`Cloudflare rejected the credentials: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
      const latencyMs = Date.now() - t0
      await secrets.set(TOKEN, token)
      await repo.settings.set('asi.brain', { provider: 'clef', accountId, model: input.model } satisfies BrainConfig)
      return { latencyMs, costPerDecisionUsd: (150 / 1e6) * PRICE_PER_M[input.model] }
    },
    async disconnect(): Promise<void> {
      await secrets.delete(TOKEN)
      await repo.settings.set('asi.brain', null)
    }
  }
}

export type Brain = ReturnType<typeof createBrain>
