import { EventHub } from '../harness/emitter'
import type { Repo } from '../main/db/repo'
import type { AgentEvent, AgentSession, UserTurn } from '@shared/events'
import type { PaletteResult } from '@shared/search'
import { pickBest, type Decider } from './decider'
import type { DiscoveredSession } from './discovery'

export interface AsiDeps {
  repo: Repo
  decider(): Promise<Decider | null>
  discover(): Promise<DiscoveredSession[]>
  search(query: string): Promise<PaletteResult[]>
}

const HELP = `I'm ASI. I keep an eye on your agents. Try:
• "status" — what is everyone doing right now
• "who needs me" — questions and permission requests waiting on you
• "outside" — Claude Code / Codex sessions running outside Messenger (I can bring them in)
• "find the refresh lock" — search every chat, message, attachment and drawing`

const STOP = new Set(['find', 'search', 'where', 'which', 'what', 'is', 'was', 'the', 'a', 'an', 'chat', 'about', 'for', 'show', 'me', 'my', 'did', 'that', 'thing', 'i', 'in', 'of', 'to'])
const terms = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w))
const ago = (ms: number) => (ms < 90_000 ? 'just now' : ms < 3600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3600_000)} h ago`)

/** The always-online friend. It reads your data and the machine; it never writes code or touches your projects. */
export class AsiAgent implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly resumeId = undefined

  constructor(private d: AsiDeps) {}

  send(turn: UserTurn): void {
    this.hub.emit({ t: 'status', phase: 'thinking' })
    void this.answer(turn.text.trim()).catch((e: unknown) => {
      this.hub.emit({ t: 'text', id: 'asi-err', delta: `I hit a problem: ${e instanceof Error ? e.message : String(e)}` })
    }).finally(() => this.hub.emit({ t: 'turn_end', reason: 'done' }))
  }

  private say(text: string, links?: Extract<AgentEvent, { t: 'links' }>['items']): void {
    this.hub.emit({ t: 'text', id: `asi-${Math.random().toString(36).slice(2, 8)}`, delta: text })
    if (links?.length) this.hub.emit({ t: 'links', items: links })
  }

  private async answer(q: string): Promise<void> {
    const l = q.toLowerCase()
    if (!q || /^(help|\?|what can you do)/.test(l)) return this.say(HELP)
    if (/\b(waiting|needs? (me|you)|blocked|questions?|permission|approve)\b/.test(l)) return this.waiting()
    if (/\b(outside|elsewhere|external|discover|active sessions|running now)\b/.test(l)) return this.outside()
    if (/^(status|overview)\b|\b(what('s| is| are).*(doing|working)|who('s| is).*(busy|working)|everyone|all (my )?agents)\b/.test(l)) return this.status()
    return this.find(q)
  }

  private async status(): Promise<void> {
    const friends = (await this.d.repo.friends.list()).filter((f) => f.harness !== 'asi')
    const chats = await this.d.repo.chats.list()
    const busy = chats.filter((c) => c.status === 'busy')
    const away = chats.filter((c) => c.status === 'away')
    if (busy.length === 0 && away.length === 0) return this.say(`All quiet. ${friends.length} friend${friends.length === 1 ? '' : 's'} registered, nobody is working or waiting on you.`)
    const name = (id: string) => friends.find((f) => f.id === id)?.displayName ?? 'Agent'
    const lines = [...away.map((c) => `⏳ ${name(c.friendId)} is waiting on you in “${c.title}”`), ...busy.map((c) => `⚙ ${name(c.friendId)} is working in “${c.title}”${c.statusText ? ` — ${c.statusText}` : ''}`)]
    this.say(lines.join('\n'), [...away, ...busy].map((c) => ({ label: c.title, detail: name(c.friendId), target: { type: 'chat' as const, chatId: c.id, workspaceId: c.workspaceId } })))
  }

  private async waiting(): Promise<void> {
    const away = (await this.d.repo.chats.list()).filter((c) => c.status === 'away')
    if (away.length === 0) return this.say('Nobody is waiting on you.')
    const friends = await this.d.repo.friends.list()
    this.say(`${away.length} chat${away.length === 1 ? ' needs' : 's need'} you:`, away.map((c) => ({ label: c.title, detail: `${friends.find((f) => f.id === c.friendId)?.displayName ?? 'Agent'}: ${c.statusText ?? 'waiting'}`, target: { type: 'chat' as const, chatId: c.id, workspaceId: c.workspaceId } })))
  }

  private async outside(): Promise<void> {
    const known = new Set((await this.d.repo.chats.list()).map((c) => c.harnessSessionId).filter(Boolean))
    const found = (await this.d.discover()).filter((s) => !known.has(s.sessionId))
    if (found.length === 0) return this.say('I don’t see any Claude Code or Codex sessions active outside Messenger in the last 15 minutes.')
    const now = Date.now()
    this.say(`${found.length} session${found.length === 1 ? '' : 's'} active outside Messenger. Bring one in to keep chatting with it here:`,
      found.slice(0, 8).map((s) => ({ label: s.title, detail: `${s.harness === 'claude' ? 'Claude Code' : 'Codex'} · ${s.cwd} · ${ago(now - s.lastActive)}`, target: { type: 'adopt' as const, harness: s.harness, sessionId: s.sessionId, cwd: s.cwd, title: s.title } })))
  }

  private async find(q: string): Promise<void> {
    const t = terms(q)
    if (t.length === 0) return this.say(HELP)
    // never search ASI's own conversations: your question would match itself
    const asi = new Set((await this.d.repo.friends.list()).filter((f) => f.harness === 'asi').map((f) => f.id))
    const own = new Set((await this.d.repo.chats.list()).filter((c) => asi.has(c.friendId)).map((c) => c.id))
    const notOwn = (r: PaletteResult) => !((r.target.type === 'chat' || r.target.type === 'attachment') && own.has(r.target.chatId))
    let hits = (await this.d.search(t.join(' '))).filter(notOwn)
    if (hits.length === 0 && t.length > 1) hits = (await Promise.all(t.map((w) => this.d.search(w)))).flat().filter(notOwn)
    const seen = new Set<string>()
    hits = hits.filter((h) => { const k = JSON.stringify(h.target); if (seen.has(k)) return false; seen.add(k); return true })
    if (hits.length === 0) return this.say(`I couldn’t find anything for “${t.join(' ')}”. Try other words, or press ⌘K.`)
    const chatHits = hits.filter((h) => h.target.type === 'chat' || h.target.type === 'attachment')
    const best = await pickBest(await this.d.decider(), q, chatHits.slice(0, 12).map((h, i) => ({ id: String(i), label: `${h.title}: ${h.snippet.replace(/[[\]]/g, '')}` })))
    const top = best !== null ? chatHits[Number(best)] : undefined
    if (top) hits = [top, ...hits.filter((h) => h !== top)]
    this.say(top ? `Best match: “${top.title}”. ${hits.length - 1 > 0 ? `${hits.length - 1} more below.` : ''}` : `${hits.length} match${hits.length === 1 ? '' : 'es'}:`,
      hits.slice(0, 6).map((h) => ({ label: h.title, detail: `${h.kind}${h.workspaceName ? ` · ${h.workspaceName}` : ''}${h.snippet ? ` · ${h.snippet.replace(/[[\]]/g, '')}` : ''}`, target: h.target })))
  }

  async interrupt(): Promise<void> {}
  respond(): void {}
  setMode(): void {}
  async dispose(): Promise<void> { this.hub.closed = true }
}
