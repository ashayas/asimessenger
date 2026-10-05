/** The decision model behind ASI (risk labels, "which chat?"). Optional; ASI uses built-in rules without one. */
export type BrainProvider = 'clef' | 'systemone' | 'llm'

export type BrainConfig =
  | { provider: 'clef'; accountId: string; model: 'clef' | 'clef-flash' }
  | { provider: 'systemone'; baseUrl: string; model: string }
  | { provider: 'llm'; baseUrl: string; model: string }

export interface BrainStatus {
  connected: boolean
  provider?: BrainProvider
  model?: string
  /** Masked Cloudflare account id (clef) or the endpoint host (others). */
  accountId?: string
  host?: string
}

export type BrainInput =
  | { provider?: 'clef'; accountId: string; token: string; model: 'clef' | 'clef-flash' }
  | { provider: 'systemone' | 'llm'; baseUrl: string; model: string; token?: string }

export interface BrainPreset {
  id: string
  label: string
  provider: BrainProvider
  baseUrl?: string
  model?: string
  /** Whether an API key is normally required (local servers do not need one). */
  needsKey: boolean
  hint: string
}

/** Starting points for the setup form. Everything stays editable. */
export const BRAIN_PRESETS: BrainPreset[] = [
  { id: 'clef', label: 'Cloudflare Clef', provider: 'clef', model: 'clef-flash', needsKey: true, hint: 'Purpose-built decision model on Cloudflare Workers AI. Fastest and cheapest.' },
  { id: 'jev', label: 'Jev (TypeSafe API)', provider: 'systemone', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', needsKey: true, hint: 'Jev through its own API with your TypeSafe key.' },
  { id: 'jev-openrouter', label: 'Jev via OpenRouter', provider: 'systemone', baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13', needsKey: true, hint: 'Jev through OpenRouter with an OpenRouter key.' },
  { id: 'llm-openrouter', label: 'Any model via OpenRouter', provider: 'llm', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-4.5', needsKey: true, hint: 'A general chat model asked for structured decisions. Works with any model.' },
  { id: 'llm-ollama', label: 'Local model (Ollama)', provider: 'llm', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false, hint: 'Runs on this Mac; nothing leaves it.' },
  { id: 'llm-custom', label: 'Other OpenAI-compatible endpoint', provider: 'llm', baseUrl: '', model: '', needsKey: false, hint: 'OpenAI, LM Studio, vLLM, or any server with /chat/completions.' }
]

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** https only, except for a server on this Mac. Returns the cleaned URL without a trailing slash. */
export function checkEndpoint(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new Error('enter the endpoint as a full URL, for example https://api.example.com') }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname))) throw new Error('the endpoint must be https (http is allowed only for a server on this Mac)')
  return u.toString().replace(/\/+$/, '')
}

export const isLocalEndpoint = (baseUrl: string): boolean => { try { return LOCAL_HOSTS.includes(new URL(baseUrl).hostname) } catch { return false } }
