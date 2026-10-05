import { EventHub } from '../emitter'
import { RpcFailure, type RpcPeer } from './rpc'
import type { AgentEvent, AgentSession, PermDecision, PermOption, ToolKind, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'
import { loadImages } from '../images'

type Obj = Record<string, unknown>

const KIND_MAP: Record<string, ToolKind> = { execute: 'exec', edit: 'edit', delete: 'edit', move: 'edit', read: 'read', search: 'search', fetch: 'web' }
const OPTION_MAP: Record<string, PermDecision> = { allow_once: 'allow-once', allow_always: 'allow-chat', reject_once: 'deny', reject_always: 'deny' }

export interface AcpSessionOptions {
  /** ACP modeId for each of our modes, when the agent exposes modes. */
  modeMap?: Partial<Record<Mode, string>>
  /** The agent advertised promptCapabilities.image, so pictures can go as image blocks. */
  images?: boolean
}

/** Maps one ACP session onto the normalized AgentSession. */
export class AcpSession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  private turn = 0
  private tools = new Map<string, Extract<AgentEvent, { t: 'tool' }>>()
  private perms = new Map<string, { resolve(v: unknown): void; options: Map<PermDecision, string>; cancelOption?: string }>()
  private prompting: Promise<void> | null = null
  private suppress = false

  constructor(
    private peer: RpcPeer,
    readonly sessionId: string,
    private opts: AcpSessionOptions = {}
  ) {
    peer.onNotification((m, p) => { if (m === 'session/update') this.onUpdate((p as Obj)['update'] as Obj) })
    peer.onRequest((m, p) => this.onAgentRequest(m, p as Obj))
    peer.onClose((reason) => {
      if (this.prompting) this.hub.emit({ t: 'turn_end', reason: 'error', error: reason })
    })
  }

  get resumeId(): string { return this.sessionId }

  /** Used while replaying history during session/load. */
  setSuppress(v: boolean): void { this.suppress = v }

  send(turn: UserTurn): void {
    const prompt: Obj[] = []
    if (turn.quote) prompt.push({ type: 'text', text: `Quoting ${turn.quote.name}:\n${turn.quote.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` })
    prompt.push({ type: 'text', text: turn.text })
    if (this.opts.images) for (const i of loadImages(turn)) prompt.push({ type: 'image', data: i.data, mimeType: i.mimeType })
    const n = ++this.turn
    this.hub.emit({ t: 'status', phase: 'thinking' })
    this.prompting = this.peer
      .request<Obj>('session/prompt', { sessionId: this.sessionId, prompt })
      .then((r) => {
        const stop = String(r?.['stopReason'] ?? 'end_turn')
        const usage = r?.['usage'] as Obj | undefined
        if (usage) this.hub.emit({ t: 'usage', inputTokens: Number(usage['inputTokens'] ?? 0), outputTokens: Number(usage['outputTokens'] ?? 0) })
        this.hub.emit({ t: 'turn_end', reason: stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'error' : 'done', ...(stop === 'refusal' ? { error: 'the agent refused' } : {}) })
      })
      .catch((err: unknown) => {
        const msg = err instanceof RpcFailure ? err.rpc.message : err instanceof Error ? err.message : String(err)
        this.hub.emit({ t: 'turn_end', reason: 'error', error: msg })
      })
      .finally(() => { this.prompting = null; void n })
  }

  async interrupt(): Promise<void> {
    for (const [id, p] of this.perms) { p.resolve({ outcome: { outcome: 'cancelled' } }); this.perms.delete(id) }
    if (!this.prompting) return
    this.peer.notify('session/cancel', { sessionId: this.sessionId })
    await Promise.race([this.prompting, new Promise((r) => setTimeout(r, 4000))])
  }

  respond(reqId: string, answer: PermDecision | string): void {
    const p = this.perms.get(reqId)
    if (!p) return
    this.perms.delete(reqId)
    const optionId = p.options.get(answer as PermDecision) ?? p.options.get('deny') ?? p.cancelOption
    p.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
    this.hub.emit({ t: 'status', phase: 'thinking' })
  }

  setMode(mode: Mode): void {
    const modeId = this.opts.modeMap?.[mode]
    if (modeId) void this.peer.request('session/set_mode', { sessionId: this.sessionId, modeId }).catch(() => {})
  }

  async dispose(): Promise<void> {
    this.hub.closed = true
    this.peer.kill()
  }

  // ---- agent -> client ----

  private async onAgentRequest(method: string, p: Obj): Promise<unknown> {
    if (method === 'session/request_permission') return this.onPermission(p)
    throw new Error(`unsupported client method ${method}`)
  }

  private onPermission(p: Obj): Promise<unknown> {
    const call = (p['toolCall'] ?? {}) as Obj
    const reqId = String(call['toolCallId'] ?? `perm-${Date.now()}`)
    const raw = (call['rawInput'] ?? {}) as Obj
    const options = new Map<PermDecision, string>()
    const shown: PermOption[] = []
    let cancelOption: string | undefined
    for (const o of (p['options'] as Obj[]) ?? []) {
      const kind = String(o['kind'])
      const decision = OPTION_MAP[kind]
      if (!decision) continue
      if (!options.has(decision)) {
        options.set(decision, String(o['optionId']))
        shown.push({ id: decision, label: decision === 'allow-once' ? 'Allow once' : decision === 'allow-chat' ? 'Allow for this chat' : 'Deny' })
      }
      if (decision === 'deny') cancelOption = String(o['optionId'])
    }
    const summary = String(raw['command'] ?? raw['filePath'] ?? raw['path'] ?? call['title'] ?? 'tool call')
    return new Promise((resolve) => {
      this.perms.set(reqId, { resolve, options, cancelOption })
      this.hub.emit({ t: 'status', phase: 'waiting', detail: summary })
      this.hub.emit({ t: 'permission', reqId, tool: String(call['kind'] ?? 'tool'), summary, options: shown })
    })
  }

  private onUpdate(u: Obj): void {
    if (this.suppress || !u) return
    const kind = String(u['sessionUpdate'])
    const content = (u['content'] ?? {}) as Obj
    switch (kind) {
      case 'agent_message_chunk':
        if (content['type'] === 'text') this.hub.emit({ t: 'text', id: String(u['messageId'] ?? `t${this.turn}`), delta: String(content['text'] ?? '') })
        return
      case 'agent_thought_chunk':
        if (content['type'] === 'text') this.hub.emit({ t: 'thinking', id: `th${this.turn}`, delta: String(content['text'] ?? '') })
        return
      case 'tool_call':
      case 'tool_call_update':
        return this.onTool(u, kind === 'tool_call_update')
      case 'plan': {
        const entries = (u['entries'] as Obj[]) ?? []
        const body = entries.map((e) => `- [${e['status'] === 'completed' ? 'x' : ' '}] ${String(e['content'])}`).join('\n')
        this.hub.emit({ t: 'attachment', id: `plan-${this.turn}`, kind: 'plan', name: 'Plan', body })
        return
      }
      case 'usage_update':
        this.hub.emit({ t: 'usage', inputTokens: Number(u['used'] ?? 0), outputTokens: 0 })
        return
      default:
        return // available_commands_update, current_mode_update, ...
    }
  }

  private onTool(u: Obj, isUpdate: boolean): void {
    const id = String(u['toolCallId'])
    const prev = this.tools.get(id)
    const raw = { ...((prev ? {} : {}) as Obj), ...((u['rawInput'] ?? {}) as Obj) }
    const status = String(u['status'] ?? (isUpdate ? 'in_progress' : 'pending'))
    const done = status === 'completed' || status === 'failed'
    const text = ((u['content'] as Obj[]) ?? [])
      .map((c) => ((c['content'] as Obj | undefined)?.['text'] ?? c['text'] ?? '') as string)
      .filter(Boolean)
      .join('\n')
    const rawOut = u['rawOutput'] as Obj | undefined
    const output = text || (rawOut?.['output'] != null ? String(rawOut['output']) : prev?.output)
    const locations = ((u['locations'] as Obj[]) ?? []).map((l) => String(l['path']))
    const kind = KIND_MAP[String(u['kind'] ?? '')] ?? prev?.kind ?? 'mcp'
    const ev: Extract<AgentEvent, { t: 'tool' }> = {
      t: 'tool',
      id,
      kind,
      title: String((prev && u['title'] === undefined ? prev.title : u['title']) ?? prev?.title ?? 'tool'),
      command: raw['command'] != null ? String(raw['command']) : prev?.command,
      output,
      exit: status === 'failed' ? 1 : done ? 0 : undefined,
      files: locations.length ? locations.map((path) => ({ path, added: 0, removed: 0 })) : prev?.files,
      done
    }
    this.tools.set(id, ev)
    if (!done) this.hub.emit({ t: 'status', phase: 'tool', detail: ev.command ?? ev.files?.[0]?.path ?? ev.title, kind: ev.kind })
    this.hub.emit(ev)
  }
}
