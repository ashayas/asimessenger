/**
 * A manifest describes how to talk to any HTTP agent: where to POST, what the body looks like,
 * how the reply streams, and which fields hold the text / conversation id / errors.
 * Adding a service (for example Cohere North) is writing one of these; no core code changes.
 */
export interface HttpManifest {
  baseUrl: string
  headers?: Record<string, string>
  /** Bearer token kept in the keychain under this secret name. */
  auth?: { type: 'bearer'; secret: string }
  send: {
    method?: 'POST' | 'PUT'
    path: string
    /** JSON body template. "{{text}}" and "{{session}}" are replaced; a key whose value is exactly "{{session}}" is dropped when there is no session yet. */
    body: unknown
  }
  /** How the reply arrives: server-sent events, one JSON per line, or a single JSON document. */
  stream: 'sse' | 'ndjson' | 'json'
  map: {
    /** Path to the text (a delta when streaming). Dot paths, e.g. "choices.0.delta.content". */
    text?: string
    /** Stop reading when this path equals `equals` (or is truthy when `equals` is omitted). */
    done?: { path: string; equals?: unknown }
    /** Path to a conversation id to send back on follow-up messages. */
    session?: string
    /** Path to an error message. */
    error?: string
  }
  /** Optional endpoint that stops a running reply (otherwise Nudge just drops the connection). */
  cancel?: { method?: 'POST' | 'DELETE'; path: string }
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function fillTemplate(tpl: unknown, vars: { text: string; session: string | null }): unknown {
  if (typeof tpl === 'string') {
    if (tpl === '{{session}}') return vars.session ?? undefined
    return tpl.replaceAll('{{text}}', vars.text).replaceAll('{{session}}', vars.session ?? '')
  }
  if (Array.isArray(tpl)) return tpl.map((t) => fillTemplate(t, vars)).filter((v) => v !== undefined)
  if (tpl && typeof tpl === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(tpl)) {
      const f = fillTemplate(v, vars)
      if (f !== undefined) out[k] = f
    }
    return out
  }
  return tpl
}

/** Validate untrusted manifest JSON (it comes from the Add a Friend form or a fork's config). */
export function parseManifest(json: string): HttpManifest {
  let m: HttpManifest
  try { m = JSON.parse(json) as HttpManifest } catch { throw new Error('the manifest is not valid JSON') }
  if (!m || typeof m !== 'object') throw new Error('the manifest must be a JSON object')
  let u: URL
  try { u = new URL(m.baseUrl) } catch { throw new Error('manifest.baseUrl must be a full URL') }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('manifest.baseUrl must be https (http is allowed only for localhost)')
  if (!m.send?.path?.startsWith('/')) throw new Error('manifest.send.path must start with "/"')
  if (m.send.body === undefined) throw new Error('manifest.send.body is required')
  if (!['sse', 'ndjson', 'json'].includes(m.stream)) throw new Error('manifest.stream must be "sse", "ndjson" or "json"')
  if (!m.map?.text) throw new Error('manifest.map.text (where the reply text is) is required')
  if (m.cancel && !m.cancel.path.startsWith('/')) throw new Error('manifest.cancel.path must start with "/"')
  return m
}
