import type { Risk } from '@shared/events'
import { heuristicRisk } from '@shared/safety'

/** Typed questions in, probabilities out. Clef (Cloudflare) and Jev answer this shape; the heuristic one runs offline. */
export type Question =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export type Questions = Record<string, Question>

export interface Answer {
  /** noul: P(yes). score: weighted score. */
  value?: number
  /** choice: most likely option. */
  choice?: string
  /** choice: probability per option. */
  probabilities?: Record<string, number>
}
export type Answers = Record<string, Answer>

export interface Decider {
  id: string
  decide(state: string, questions: Questions): Promise<Answers>
}

export interface ClefConfig {
  /** Override for tests; defaults to Cloudflare's API. */
  baseUrl?: string
  accountId: string
  token: string
  model?: 'clef' | 'clef-flash'
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Cloudflare Workers AI "Decisions": one forward pass, a probability for every option of every question. */
export function clefDecider(c: ClefConfig): Decider {
  const model = c.model ?? 'clef-flash'
  return {
    id: model,
    async decide(state, questions) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 8000)
      try {
        const res = await (c.fetchImpl ?? fetch)(`${c.baseUrl ?? 'https://api.cloudflare.com'}/client/v4/accounts/${encodeURIComponent(c.accountId)}/ai/run/@cf/cloudflare/${model}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, state, questions }),
          signal: ctl.signal
        })
        const body = (await res.json().catch(() => null)) as { result?: unknown; success?: boolean; errors?: { message: string }[] } | null
        if (!res.ok || (body && body.success === false)) throw new Error(body?.errors?.[0]?.message ?? `Cloudflare answered ${res.status}`)
        const payload = ((body?.result ?? body) as { answers?: Record<string, unknown> } | null)?.answers
        if (!payload) throw new Error('Cloudflare returned no answers')
        return parseAnswers(payload, questions)
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/** The Clef answer for a question may be a bare number or an object; accept both. */
export function parseAnswers(raw: Record<string, unknown>, questions: Questions): Answers {
  const out: Answers = {}
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id]
    if (a === undefined || a === null) continue
    if (typeof a === 'number') { out[id] = { value: a }; continue }
    const o = a as { noul?: number; score?: number; choice?: string; probabilities?: Record<string, number> }
    if (q.type === 'choice') {
      const probs = o.probabilities
      const best = o.choice ?? (probs ? Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0] : undefined)
      out[id] = { choice: best, probabilities: probs }
    } else out[id] = { value: q.type === 'noul' ? o.noul : o.score }
  }
  return out
}

const RISK_ORDER: Risk[] = ['low', 'med', 'high']
const RISKS = { low: 'Safe, reversible, read-only or inside the project', med: 'Changes state outside the project or is hard to undo, such as installs, network or git pushes', high: 'Destructive, privileged, or touches secrets and system files' }
export const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b)

/**
 * Risk of a permission request. The local heuristic is a floor: the decider can raise a label but never
 * talk us out of "high". Any failure falls back to the heuristic alone.
 */
export async function assessRisk(decider: Decider | null, tool: string, summary: string): Promise<{ risk: Risk; source: string }> {
  const floor = heuristicRisk(tool, summary)
  if (!decider) return { risk: floor, source: 'heuristic' }
  try {
    const a = await decider.decide(`A coding agent asks permission to use the "${tool}" tool: ${summary}`, { risk: { type: 'choice', instructions: 'How risky is it to allow this action on the user’s machine?', criteria: RISKS } })
    const r = a['risk']?.choice
    if (r === 'low' || r === 'med' || r === 'high') return { risk: maxRisk(floor, r), source: decider.id }
  } catch { /* offline, bad token, rate limit */ }
  return { risk: floor, source: 'heuristic' }
}

/** Pick the best-matching candidate for a question, or null when nothing is a confident match. */
export async function pickBest(decider: Decider | null, query: string, candidates: { id: string; label: string }[], minProb = 0.4): Promise<string | null> {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!.id
  if (!decider) return null
  try {
    const a = await decider.decide(query, { match: { type: 'choice', instructions: 'Which item is the user asking about?', criteria: Object.fromEntries(candidates.slice(0, 20).map((c) => [c.id, c.label])) } })
    const best = a['match']
    const p = best?.choice ? best.probabilities?.[best.choice] ?? 1 : 0
    return best?.choice && p >= minProb ? best.choice : null
  } catch {
    return null
  }
}
