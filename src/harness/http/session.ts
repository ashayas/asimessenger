import { EventHub } from '../emitter'
import { fillTemplate, getPath, type HttpManifest } from './manifest'
import type { AgentSession, UserTurn } from '@shared/events'

export interface HttpOptions {
  manifest: HttpManifest
  token: string | null
  resumeId?: string | null
  fetchImpl?: typeof fetch
}

/** Any streaming HTTP agent, driven by a manifest. Nudge aborts the request (and calls cancel if the manifest has one). */
export class HttpSession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  private session: string | null
  private ctl: AbortController | null = null
  private turn = 0

  constructor(private o: HttpOptions) { this.session = o.resumeId ?? null }
  get resumeId(): string | undefined { return this.session ?? undefined }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Accept: this.o.manifest.stream === 'sse' ? 'text/event-stream' : 'application/json', ...(this.o.manifest.headers ?? {}), ...(this.o.token ? { Authorization: `Bearer ${this.o.token}` } : {}) }
  }

  send(turn: UserTurn): void {
    void this.run(turn).catch((e: unknown) => {
      if (this.ctl?.signal.aborted) return
      this.hub.emit({ t: 'turn_end', reason: 'error', error: e instanceof Error ? e.message : String(e) })
    })
  }

  private async run(turn: UserTurn): Promise<void> {
    const m = this.o.manifest
    const text = turn.quote ? `Quoting ${turn.quote.name}:\n${turn.quote.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${turn.text}` : turn.text
    const id = `http-${++this.turn}`
    const ctl = (this.ctl = new AbortController())
    this.hub.emit({ t: 'status', phase: 'thinking' })
    const res = await (this.o.fetchImpl ?? fetch)(new URL(m.send.path, m.baseUrl).toString(), { method: m.send.method ?? 'POST', headers: this.headers(), body: JSON.stringify(fillTemplate(m.send.body, { text, session: this.session })), signal: ctl.signal })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      return void this.hub.emit({ t: 'turn_end', reason: 'error', error: `${new URL(m.baseUrl).host} answered ${res.status}${detail ? `: ${detail}` : ''}` })
    }
    let finished = false
    let ended = false // a turn_end (error) already went out
    const handle = (obj: unknown): void => {
      if (m.map.session) { const s = getPath(obj, m.map.session); if (typeof s === 'string' && s) this.session = s }
      if (m.map.error) { const e = getPath(obj, m.map.error); if (e) { finished = true; ended = true; return void this.hub.emit({ t: 'turn_end', reason: 'error', error: String(typeof e === 'object' ? JSON.stringify(e) : e) }) } }
      const t = getPath(obj, m.map.text!)
      if (typeof t === 'string' && t) this.hub.emit({ t: 'text', id, delta: t })
      if (m.map.done) {
        const v = getPath(obj, m.map.done.path)
        if (m.map.done.equals === undefined ? !!v : v === m.map.done.equals) finished = true
      }
    }
    if (m.stream === 'json') {
      handle(await res.json())
    } else {
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const sep = m.stream === 'sse' ? /\r?\n\r?\n/ : /\r?\n/
      const parse = (chunk: string): void => {
        const data = m.stream === 'sse' ? chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n') : chunk.trim()
        if (!data || data === '[DONE]') return void (data === '[DONE]' && (finished = true))
        try { handle(JSON.parse(data)) } catch { /* keep-alive or non-JSON line */ }
      }
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let m2: RegExpExecArray | null
        while (!finished && (m2 = sep.exec(buf))) { parse(buf.slice(0, m2.index)); buf = buf.slice(m2.index + m2[0].length) }
      }
      if (!finished && buf.trim()) parse(buf)
      if (finished) void reader.cancel().catch(() => {})
    }
    if (!ended && this.ctl === ctl && !ctl.signal.aborted) this.hub.emit({ t: 'turn_end', reason: 'done' })
  }

  async interrupt(): Promise<void> {
    const c = this.ctl
    if (!c) return
    c.abort()
    const m = this.o.manifest
    if (m.cancel) void (this.o.fetchImpl ?? fetch)(new URL(m.cancel.path.replace('{{session}}', this.session ?? ''), m.baseUrl).toString(), { method: m.cancel.method ?? 'POST', headers: this.headers() }).catch(() => {})
    this.hub.emit({ t: 'turn_end', reason: 'interrupted' })
  }

  respond(): void {}
  setMode(): void {}
  async dispose(): Promise<void> { this.ctl?.abort(); this.hub.closed = true }
}
