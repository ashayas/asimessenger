import { spawn } from 'node:child_process'
import { EventHub } from '../emitter'
import { RpcFailure, RpcPeer } from '../acp/rpc'
import type { AgentEvent, AgentSession, FileChange, PermDecision, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'

type Obj = Record<string, unknown>
type Tool = Extract<AgentEvent, { t: 'tool' }>

interface Policy { approvalPolicy: string; sandbox: string; sandboxPolicy: Obj }

/** Our modes -> Codex approval policy + sandbox. */
export const POLICY: Record<Mode, Policy> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  'auto-edit': { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  dangerous: { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
}

export interface CodexOptions {
  command: string
  env: NodeJS.ProcessEnv
  cwd: string
  mode: Mode
  resumeId?: string | null
  extraArgs?: string[]
  prefixArgs?: string[]
  mcp?: { url: string; token: string }
}

const countDiff = (diff: string): { added: number; removed: number } => {
  let added = 0, removed = 0
  for (const l of diff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++ }
  return { added, removed }
}

/** Codex over `codex app-server` (JSON-RPC). Started with createCodexSession(), which performs the handshake. */
export class CodexSession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  threadId = ''
  private turnId: string | null = null
  private mode: Mode
  private streamed = new Set<string>()
  private tools = new Map<string, Tool>()
  private pending = new Map<string, { resolve(v: unknown): void; kind: 'command' | 'file' | 'question' | 'permissions'; params: Obj }>()
  private active = false
  private interrupting = false

  private constructor(private peer: RpcPeer, private o: CodexOptions) {
    this.mode = o.mode
    peer.onNotification((m, p) => this.onNotification(m, (p ?? {}) as Obj))
    peer.onRequest((m, p) => this.onServerRequest(m, (p ?? {}) as Obj))
    peer.onClose((reason) => { if (this.active) { this.active = false; this.hub.emit({ t: 'turn_end', reason: 'error', error: reason }) } })
  }

  get resumeId(): string { return this.threadId }

  static async create(o: CodexOptions): Promise<CodexSession> {
    const mcpArgs = o.mcp
      ? ['-c', `mcp_servers.asi.url=${JSON.stringify(o.mcp.url)}`, '-c', 'mcp_servers.asi.bearer_token_env_var="ASI_MCP_TOKEN"', '-c', 'mcp_servers.asi.tool_timeout_sec=3600', '-c', 'mcp_servers.asi.default_tools_approval_mode="approve"']
      : []
    const env = o.mcp ? { ...o.env, ASI_MCP_TOKEN: o.mcp.token } : o.env
    const child = spawn(o.command, [...(o.prefixArgs ?? []), 'app-server', ...mcpArgs, ...(o.extraArgs ?? [])], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const peer = new RpcPeer(child, { jsonrpcField: false })
    const s = new CodexSession(peer, o)
    try {
      await peer.request('initialize', { clientInfo: { name: 'asi-messenger', title: 'ASI Messenger', version: '0.1.0' }, capabilities: null })
      peer.notify('initialized')
      const pol = POLICY[o.mode]
      const params = { cwd: o.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox }
      let res: Obj | null = null
      if (o.resumeId) {
        try { res = await peer.request<Obj>('thread/resume', { threadId: o.resumeId, ...params }) } catch { res = null }
      }
      if (!res) res = await peer.request<Obj>('thread/start', params)
      s.threadId = String((res['thread'] as Obj)['id'])
      return s
    } catch (err) {
      peer.kill()
      const msg = err instanceof RpcFailure ? err.rpc.message : err instanceof Error ? err.message : String(err)
      throw new Error(msg, { cause: err })
    }
  }

  send(turn: UserTurn): void {
    const text = turn.quote ? `Quoting ${turn.quote.name}:\n${turn.quote.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${turn.text}` : turn.text
    const pol = POLICY[this.mode]
    this.active = true
    this.interrupting = false
    this.hub.emit({ t: 'status', phase: 'thinking' })
    this.peer
      .request<Obj>('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }, ...(turn.images ?? []).map((i) => ({ type: 'localImage', path: i.path }))],
        approvalPolicy: pol.approvalPolicy,
        sandboxPolicy: pol.sandboxPolicy
      })
      .then((r) => { this.turnId = String((r['turn'] as Obj)['id']) })
      .catch((err: unknown) => {
        this.active = false
        this.hub.emit({ t: 'turn_end', reason: 'error', error: err instanceof RpcFailure ? err.rpc.message : String(err) })
      })
  }

  async interrupt(): Promise<void> {
    if (!this.active) return
    this.interrupting = true
    for (const [id, p] of this.pending) { p.resolve(this.declineFor(p.kind, p.params)); this.pending.delete(id) }
    const t0 = Date.now()
    while (!this.turnId && this.active && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 25))
    if (this.turnId) await this.peer.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
    while (this.active && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 25))
    if (this.active) { this.active = false; this.hub.emit({ t: 'turn_end', reason: 'interrupted' }) }
  }

  respond(reqId: string, answer: PermDecision | string): void {
    const p = this.pending.get(reqId)
    if (!p) return
    this.pending.delete(reqId)
    if (p.kind === 'question') {
      const q = ((p.params['questions'] as Obj[]) ?? [])[0] ?? {}
      p.resolve({ answers: { [String(q['id'])]: { answers: [answer] } } })
    } else if (p.kind === 'permissions') {
      p.resolve(answer === 'deny' ? { permissions: {}, scope: 'turn' } : { permissions: p.params['permissions'], scope: answer === 'allow-chat' ? 'session' : 'turn' })
    } else {
      p.resolve({ decision: answer === 'allow-once' ? 'accept' : answer === 'allow-chat' ? 'acceptForSession' : 'decline' })
    }
    this.hub.emit({ t: 'status', phase: 'thinking' })
  }

  /** Applied from the next turn on (turn/start carries the policy). */
  setMode(mode: Mode): void { this.mode = mode }

  async dispose(): Promise<void> {
    this.hub.closed = true
    this.peer.kill()
  }

  private declineFor(kind: string, params: Obj): unknown {
    if (kind === 'question') return { answers: {} }
    if (kind === 'permissions') return { permissions: {}, scope: 'turn' }
    void params
    return { decision: 'cancel' }
  }

  // ---- server -> client requests ----

  private onServerRequest(method: string, p: Obj): Promise<unknown> {
    const reqId = String(p['approvalId'] ?? p['itemId'] ?? `req-${Date.now()}`)
    const itemId = String(p['itemId'] ?? '')
    if (method === 'item/commandExecution/requestApproval') {
      const summary = String(p['command'] ?? p['reason'] ?? 'run a command')
      return this.ask(reqId, 'command', p, { tool: 'exec', summary }, true)
    }
    if (method === 'item/fileChange/requestApproval') {
      const files = this.tools.get(itemId)?.files?.map((f) => f.path).join(', ')
      return this.ask(reqId, 'file', p, { tool: 'edit', summary: files || String(p['reason'] ?? 'edit files') }, true)
    }
    if (method === 'item/permissions/requestApproval') {
      return this.ask(reqId, 'permissions', p, { tool: 'permissions', summary: String(p['reason'] ?? 'extra permissions') }, true)
    }
    if (method === 'item/tool/requestUserInput') {
      const q = ((p['questions'] as Obj[]) ?? [])[0] ?? {}
      return new Promise((resolve) => {
        this.pending.set(reqId, { resolve, kind: 'question', params: p })
        this.hub.emit({ t: 'status', phase: 'waiting', detail: 'question' })
        this.hub.emit({ t: 'question', reqId, prompt: String(q['question'] ?? 'The agent has a question'), choices: ((q['options'] as Obj[] | null) ?? []).map((o) => String(o['label'])) })
      })
    }
    return Promise.reject(new Error(`unsupported request ${method}`))
  }

  private ask(reqId: string, kind: 'command' | 'file' | 'permissions', params: Obj, info: { tool: string; summary: string }, session: boolean): Promise<unknown> {
    return new Promise((resolve) => {
      this.pending.set(reqId, { resolve, kind, params })
      this.hub.emit({ t: 'status', phase: 'waiting', detail: info.summary })
      this.hub.emit({
        t: 'permission', reqId, tool: info.tool, summary: info.summary,
        options: [{ id: 'allow-once', label: 'Allow once' }, ...(session ? [{ id: 'allow-chat' as const, label: 'Allow for this chat' }] : []), { id: 'deny', label: 'Deny' }]
      })
    })
  }

  // ---- notifications ----

  private onNotification(method: string, p: Obj): void {
    switch (method) {
      case 'turn/started': this.turnId = String((p['turn'] as Obj)['id']); return
      case 'item/started': return this.onItem(p['item'] as Obj, false)
      case 'item/completed': return this.onItem(p['item'] as Obj, true)
      case 'item/agentMessage/delta':
        this.streamed.add(String(p['itemId']))
        this.hub.emit({ t: 'text', id: String(p['itemId']), delta: String(p['delta']) })
        return
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (p['delta']) this.hub.emit({ t: 'thinking', id: String(p['itemId']), delta: String(p['delta']) })
        return
      case 'thread/tokenUsage/updated': {
        const u = ((p['tokenUsage'] as Obj)?.['total'] ?? {}) as Obj
        this.hub.emit({ t: 'usage', inputTokens: Number(u['inputTokens'] ?? 0), outputTokens: Number(u['outputTokens'] ?? 0) })
        return
      }
      case 'turn/completed': return this.onTurnCompleted((p['turn'] ?? {}) as Obj)
      default: return
    }
  }

  private onTurnCompleted(turn: Obj): void {
    this.active = false
    this.turnId = null
    this.streamed.clear()
    const status = String(turn['status'])
    if (status === 'interrupted' || this.interrupting) return void this.hub.emit({ t: 'turn_end', reason: 'interrupted' })
    if (status === 'failed') return void this.hub.emit({ t: 'turn_end', reason: 'error', error: String(((turn['error'] ?? {}) as Obj)['message'] ?? 'the turn failed') })
    this.hub.emit({ t: 'turn_end', reason: 'done' })
  }

  private onItem(item: Obj, done: boolean): void {
    const id = String(item['id'])
    switch (item['type']) {
      case 'commandExecution': {
        const status = String(item['status'])
        const ev: Tool = {
          t: 'tool', id, kind: 'exec', title: 'Run command', command: String(item['command'] ?? ''), cwd: item['cwd'] ? String(item['cwd']) : undefined,
          output: item['aggregatedOutput'] != null ? String(item['aggregatedOutput']) : undefined,
          exit: done ? (item['exitCode'] != null ? Number(item['exitCode']) : status === 'declined' ? 1 : undefined) : undefined,
          durationMs: item['durationMs'] != null ? Number(item['durationMs']) : undefined, done
        }
        this.tools.set(id, ev)
        if (!done) this.hub.emit({ t: 'status', phase: 'tool', detail: ev.command, kind: 'exec' })
        this.hub.emit(ev)
        return
      }
      case 'fileChange': {
        const files: FileChange[] = ((item['changes'] as Obj[]) ?? []).map((c) => ({ path: String(c['path']), ...countDiff(String(c['diff'] ?? '')) }))
        const status = String(item['status'])
        const ev: Tool = { t: 'tool', id, kind: 'edit', title: 'Edit files', files, done, ...(done ? { exit: status === 'completed' ? 0 : 1 } : {}) }
        this.tools.set(id, ev)
        if (!done) this.hub.emit({ t: 'status', phase: 'tool', detail: files.map((f) => f.path).join(', '), kind: 'edit' })
        this.hub.emit(ev)
        return
      }
      case 'mcpToolCall': {
        const ev: Tool = { t: 'tool', id, kind: 'mcp', title: `${String(item['server'])}.${String(item['tool'])}`, done, ...(done ? { exit: item['error'] ? 1 : 0 } : {}) }
        this.tools.set(id, ev)
        this.hub.emit(ev)
        return
      }
      case 'agentMessage':
        if (done && !this.streamed.has(id) && item['text']) this.hub.emit({ t: 'text', id, delta: String(item['text']) })
        return
      case 'plan':
        if (done) this.hub.emit({ t: 'attachment', id, kind: 'plan', name: 'Plan', body: String(item['text'] ?? '') })
        return
      default:
        return
    }
  }
}
