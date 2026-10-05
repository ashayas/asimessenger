/**
 * Masks secrets in text before it leaves the machine for a model (risk labels, "which chat?", chat titles).
 * Conservative on purpose: well-known key formats and clearly named secret assignments, not "anything that looks random",
 * so ordinary text, commit hashes and UUIDs pass through untouched.
 */
export interface Redaction {
  text: string
  /** How many secrets were masked, and of which kinds. */
  count: number
  kinds: string[]
}

type Rule = { kind: string; re: RegExp; /** keep the leading capture group (the name) and mask only the value */ keep?: boolean }

const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openrouter-key', re: /\bsk-or-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer-token', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, keep: true },
  { kind: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/(?!\[REDACTED)[^\s/:@]+:)[^\s/@]+(?=@)/gi, keep: true },
  // NAME=value / NAME: value where the name says it is a secret (API_KEY, db_password, AUTH_TOKEN ...)
  { kind: 'secret-assignment', re: /(\b[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)(?!\[REDACTED)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'`;&|]{6,})/gi, keep: true },
  // --password hunter2 / --token=abc / --api-key abc
  { kind: 'secret-flag', re: /(--?(?:password|passwd|token|secret|api-?key|auth)(?:=|\s+))(?!\[REDACTED)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'`;&|-][^\s"'`;&|]{3,})/gi, keep: true }
]

export function redactSecrets(input: string): Redaction {
  let text = input
  let count = 0
  const kinds = new Set<string>()
  for (const r of RULES) {
    text = text.replace(r.re, (...args: unknown[]) => {
      count++
      kinds.add(r.kind)
      const lead = r.keep ? String(args[1] ?? '') : ''
      return `${lead}[REDACTED:${r.kind}]`
    })
  }
  return { text, count, kinds: [...kinds] }
}

/** Redact every string in a JSON-like value (question sets, criteria), leaving keys and structure alone. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value).text as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])) as T
  return value
}
