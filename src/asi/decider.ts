import type { Risk } from '@shared/events'
import { heuristicRisk } from '@shared/safety'
import { redactDeep, redactSecrets } from '@shared/redact'
import { cleanTitle } from '@shared/title'

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
          body: JSON.stringify({ model, state: redactSecrets(state).text, questions: redactDeep(questions) }),
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

function weightedLevel(probs: Record<string, number>): number | undefined {
  let total = 0
  let sum = 0
  for (const [level, p] of Object.entries(probs)) { const n = Number(level); if (Number.isFinite(n) && p > 0) { sum += n * p; total += p } }
  return total > 0 ? sum / total : undefined
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
    } else if (q.type === 'score' && o.score === undefined && o.probabilities) {
      out[id] = { value: weightedLevel(o.probabilities), probabilities: o.probabilities } // a distribution over levels: report its mean level
    } else out[id] = { value: q.type === 'noul' ? o.noul : o.score }
  }
  return out
}

export interface EndpointConfig {
  /** Endpoint root, e.g. https://api.typesafe.ai, https://openrouter.ai/api or http://localhost:11434/v1. */
  baseUrl: string
  model: string
  /** Bearer token. Optional for local servers. */
  token?: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

async function postJson(c: EndpointConfig, url: string, body: unknown): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 8000)
  try {
    const res = await (c.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal
    })
    const parsed = (await res.json().catch(() => null)) as { error?: { message?: string } | string; errors?: { message: string }[] } | null
    if (!res.ok) {
      const e = parsed?.error
      throw new Error((typeof e === 'string' ? e : e?.message) ?? parsed?.errors?.[0]?.message ?? `${new URL(url).host} answered ${res.status}`)
    }
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Jev, and any server that speaks the same "systemone" shape (TypeSafe's API, or OpenRouter's typesafe/jev route):
 * POST {baseUrl}/v1/systemone {state, model, questions} -> {answers: {id: {type, noul | choice+probabilities | score+probabilities}}}.
 */
export function systemOneDecider(c: EndpointConfig): Decider {
  return {
    id: c.model,
    async decide(state, questions) {
      const body = (await postJson(c, `${c.baseUrl.replace(/\/+$/, '')}/v1/systemone`, { state: redactSecrets(state).text, model: c.model, questions: redactDeep(questions) })) as { answers?: Record<string, unknown> } | null
      if (!body?.answers) throw new Error('the endpoint returned no answers')
      return parseAnswers(body.answers, questions)
    }
  }
}

/** One plain completion from an OpenAI-compatible chat model. */
export async function llmComplete(c: EndpointConfig, system: string, user: string, maxTokens = 40): Promise<string> {
  const body = (await postJson({ ...c, timeoutMs: c.timeoutMs ?? 30_000 }, `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    model: c.model, temperature: 0.2, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: redactSecrets(user).text }]
  })) as { choices?: { message?: { content?: string } }[] } | null
  const content = body?.choices?.[0]?.message?.content
  if (!content) throw new Error('the model returned no content')
  return content
}

const TITLE_SYSTEM = 'You name chat conversations between a person and a coding agent. Reply with a title only: 2 to 6 words, lower case unless a name needs capitals, no quotes, no trailing punctuation. Say what the work is about, not that it is a conversation.'

/** A short title for a chat from its first exchange. */
export async function llmTitle(c: EndpointConfig, userText: string, agentText: string): Promise<string> {
  const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 400)
  return cleanTitle(await llmComplete(c, TITLE_SYSTEM, `The person said: ${clip(userText)}\nThe agent replied: ${clip(agentText)}`))
}

const LLM_SYSTEM = `You are a decision engine. You receive a STATE and a set of QUESTIONS and answer every question with calibrated probabilities. Reply with one JSON object only, no prose, shaped {"answers": {<question id>: <answer>}} where:
- a "noul" question (yes/no) is answered {"noul": <probability of yes between 0 and 1>}
- a "choice" question is answered {"probabilities": {<option>: <probability>, ...}} with every option from its criteria and probabilities summing to 1
- a "score" question is answered {"score": <number between 0 and 1 for how well the criteria are met>}`

/** Pulls the first JSON object out of a model reply, tolerating code fences and chatter around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/** Clamp to [0,1] and make a distribution sum to 1, so a chatty model cannot break the ranking. */
function normalize(raw: Record<string, unknown>, questions: Questions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id] as Record<string, unknown> | number | undefined
    if (a === undefined || a === null) continue
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined)
    if (q.type === 'noul') { const v = num(typeof a === 'number' ? a : a['noul']); if (v !== undefined) out[id] = { noul: v } }
    else if (q.type === 'score') { const v = num(typeof a === 'number' ? a : a['score']); if (v !== undefined) out[id] = { score: v } }
    else if (typeof a === 'object' && a['probabilities'] && typeof a['probabilities'] === 'object') {
      const options = new Set(Object.keys(q.criteria))
      // keep the ratios (a model may answer 2 and 6 meaning 25% and 75%): only drop negatives and non-numbers, then rescale
      const picked = Object.entries(a['probabilities'] as Record<string, unknown>).filter(([k, v]) => options.has(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0).map(([k, v]) => [k, v as number] as const)
      const total = picked.reduce((n, [, v]) => n + v, 0)
      if (total > 0) out[id] = { probabilities: Object.fromEntries(picked.map(([k, v]) => [k, v / total])) }
    }
  }
  return out
}

/**
 * Any OpenAI-compatible chat model (OpenRouter, OpenAI, Ollama, LM Studio, a vLLM server...) used as a decision model:
 * it is asked for the same typed answers and its JSON is validated and normalized. Slower and less calibrated than a
 * purpose-built model like Clef or Jev, but it works with anything, including fully local models.
 */
export function llmDecider(c: EndpointConfig): Decider {
  return {
    id: c.model,
    async decide(state, questions) {
      const body = (await postJson({ ...c, timeoutMs: c.timeoutMs ?? 30_000 }, `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        model: c.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: LLM_SYSTEM }, { role: 'user', content: JSON.stringify({ state: redactSecrets(state).text, questions: redactDeep(questions) }) }]
      })) as { choices?: { message?: { content?: string } }[] } | null
      const content = body?.choices?.[0]?.message?.content
      if (!content) throw new Error('the model returned no content')
      const parsed = extractJson(content) as { answers?: Record<string, unknown> }
      const answers = normalize(parsed.answers ?? (parsed as Record<string, unknown>), questions)
      if (Object.keys(answers).length === 0) throw new Error('the model did not answer the questions')
      return parseAnswers(answers, questions)
    }
  }
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
