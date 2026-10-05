import type { Repo } from '../main/db/repo'
import type { Secrets } from '../main/secrets'
import { checkEndpoint, isLocalEndpoint, type BrainConfig, type BrainInput, type BrainStatus } from '@shared/brain'
import { clefDecider, llmDecider, systemOneDecider, type Decider } from './decider'

export type { BrainConfig, BrainStatus }

const PRICE_PER_M: Record<'clef' | 'clef-flash', number> = { 'clef-flash': 0.09, clef: 0.24 }
const TOKEN = 'brain-token'
const LEGACY_CLEF_TOKEN = 'cloudflare-token'

const mask = (id: string) => (id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)
const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }

/** ASI's decision model: Cloudflare Clef, Jev, or any OpenAI-compatible model. Credentials live in the keychain. */
export function createBrain(repo: Repo, secrets: Secrets, fetchImpl?: typeof fetch, clefBase?: string) {
  const token = async (cfg: BrainConfig): Promise<string | null> => (await secrets.get(TOKEN)) ?? (cfg.provider === 'clef' ? await secrets.get(LEGACY_CLEF_TOKEN) : null)
  const build = (cfg: BrainConfig, tok: string | null, timeoutMs?: number): Decider =>
    cfg.provider === 'clef' ? clefDecider({ accountId: cfg.accountId, token: tok ?? '', model: cfg.model, fetchImpl, baseUrl: clefBase, timeoutMs })
    : cfg.provider === 'systemone' ? systemOneDecider({ baseUrl: cfg.baseUrl, model: cfg.model, token: tok, fetchImpl, timeoutMs })
    : llmDecider({ baseUrl: cfg.baseUrl, model: cfg.model, token: tok, fetchImpl, timeoutMs })
  const needsToken = (cfg: BrainConfig) => cfg.provider === 'clef' || !isLocalEndpoint(cfg.baseUrl)

  return {
    async status(): Promise<BrainStatus> {
      const cfg = await repo.settings.get<BrainConfig | null>('asi.brain', null)
      if (!cfg) return { connected: false }
      if (needsToken(cfg) && !(await token(cfg))) return { connected: false }
      return cfg.provider === 'clef'
        ? { connected: true, provider: 'clef', model: cfg.model, accountId: mask(cfg.accountId) }
        : { connected: true, provider: cfg.provider, model: cfg.model, host: hostOf(cfg.baseUrl) }
    },
    /** The decider to use right now, or null (offline heuristics) when not connected. */
    async decider(): Promise<Decider | null> {
      const cfg = await repo.settings.get<BrainConfig | null>('asi.brain', null)
      if (!cfg) return null
      const tok = await token(cfg)
      if (needsToken(cfg) && !tok) return null
      return build(cfg, tok)
    },
    /** The endpoint to write chat titles with. Only a general chat model can write text; Clef and Jev are classifiers. */
    async titleModel(): Promise<{ baseUrl: string; model: string; token: string | null; fetchImpl?: typeof fetch } | null> {
      const cfg = await repo.settings.get<BrainConfig | null>('asi.brain', null)
      if (!cfg || cfg.provider !== 'llm') return null
      const tok = await token(cfg)
      if (needsToken(cfg) && !tok) return null
      return { baseUrl: cfg.baseUrl, model: cfg.model, token: tok, fetchImpl }
    },
    /** Validates with one real decision, then stores. Nothing is saved on failure. */
    async connect(input: BrainInput): Promise<{ latencyMs: number; costPerDecisionUsd: number | null }> {
      let cfg: BrainConfig
      const tok = (input.token ?? '').trim()
      if (!('baseUrl' in input)) {
        const accountId = input.accountId.trim()
        if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('a Cloudflare account ID is 32 hex characters (dashboard › Workers & Pages › right sidebar)')
        if (tok.length < 20) throw new Error('paste an API token with the “Workers AI” permission')
        cfg = { provider: 'clef', accountId, model: input.model }
      } else {
        const baseUrl = checkEndpoint(input.baseUrl)
        const model = input.model.trim()
        if (!model) throw new Error('enter the model name')
        if (!tok && !isLocalEndpoint(baseUrl)) throw new Error('paste the API key for this endpoint')
        cfg = { provider: input.provider, baseUrl, model }
      }
      const d = build(cfg, tok || null, 30_000)
      const t0 = Date.now()
      try {
        const a = await d.decide('ASI Messenger connection test', { ok: { type: 'noul', instructions: 'Is this a test message?' } })
        if (a['ok']?.value === undefined) throw new Error('it answered, but not in the decision format')
      } catch (e) {
        throw new Error(`${cfg.provider === 'clef' ? 'Cloudflare' : hostOf((cfg as { baseUrl: string }).baseUrl)} rejected the connection: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
      const latencyMs = Date.now() - t0
      if (tok) await secrets.set(TOKEN, tok)
      else await secrets.delete(TOKEN)
      await repo.settings.set('asi.brain', cfg)
      return { latencyMs, costPerDecisionUsd: cfg.provider === 'clef' ? (150 / 1e6) * PRICE_PER_M[cfg.model] : null }
    },
    async disconnect(): Promise<void> {
      await secrets.delete(TOKEN)
      await secrets.delete(LEGACY_CLEF_TOKEN)
      await repo.settings.set('asi.brain', null)
    }
  }
}

export type Brain = ReturnType<typeof createBrain>
