import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventHub } from '../emitter'
import type { AgentEvent, AgentSession, FileChange, PermDecision, ToolKind, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'

type Obj = Record<string, unknown>

const MODE_FLAG: Record<Mode, string> = { ask: 'manual', 'auto-edit': 'acceptEdits', plan: 'plan', dangerous: 'bypassPermissions' }

export function toolKind(name: string): ToolKind {
  if (name === 'Bash' || name === 'PowerShell') return 'exec'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit'
  if (/^(Read|Glob|NotebookRead)$/.test(name)) return 'read'
  if (name === 'Grep') return 'search'
  if (/^Web/.test(name)) return 'web'
  return 'mcp'
}

function describeTool(name: string, input: Obj): { command?: string; files?: FileChange[] } {
  if (name === 'Bash' || name === 'PowerShell') return { command: String(input['command'] ?? '') }
  const path = input['file_path'] ?? input['notebook_path'] ?? input['path']
  if (path) return { files: [{ path: String(path), added: 0, removed: 0 }] }
  if (input['pattern']) return { command: `${name} ${String(input['pattern'])}` }
  if (input['url']) return { command: String(input['url']) }
  return {}
}

export interface ClaudeOptions {
  command: string
  env: NodeJS.ProcessEnv
  cwd: string
  mode: Mode
  dangerousAllowed: boolean
  resumeId?: string | null
  extraArgs?: string[]
  /** Args placed before claude's own (tests run a node script through this). */
  prefixArgs?: string[]
}

/** Claude Code over `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`. */
export class ClaudeSession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly resumeId: string
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private stderrTail = ''
  private msgId = ''
  private streamed = new Set<string>()
  private tools = new Map<string, Extract<AgentEvent, { t: 'tool' }>>()
  private pending = new Map<string, { toolUseId: string; input: Obj; suggestions: unknown; question?: { prompt: string } }>()
  private interrupting = false
  private active = false
  private reqN = 0

  constructor(private o: ClaudeOptions) {
    this.resumeId = o.resumeId || randomUUID()
    const args = [
      ...(o.prefixArgs ?? []),
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio', '--permission-mode', MODE_FLAG[o.mode],
      ...(o.resumeId ? ['--resume', o.resumeId] : ['--session-id', this.resumeId]),
      ...(o.dangerousAllowed ? ['--allow-dangerously-skip-permissions'] : []),
      ...(o.extraArgs ?? [])
    ]
    const env = { ...o.env }
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]
    this.child = spawn(o.command, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d: string) => this.onData(d))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-1500) })
    this.child.on('error', (err) => this.fail(`failed to start claude: ${err.message}`))
    this.child.on('exit', (code, sig) => {
      if (this.hub.closed) return
      const tail = this.stderrTail.trim().split('\n').pop()
      this.fail(`claude exited (${sig ?? code})${tail ? `: ${tail}` : ''}`)
    })
  }

  private fail(error: string): void {
    if (this.active) { this.active = false; this.hub.emit({ t: 'turn_end', reason: 'error', error }) }
  }

  private write(obj: Obj): void {
    if (!this.child.killed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  send(turn: UserTurn): void {
    const text = turn.quote ? `Quoting ${turn.quote.name}:\n${turn.quote.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${turn.text}` : turn.text
    this.active = true
    this.interrupting = false
    this.hub.emit({ t: 'status', phase: 'thinking' })
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  async interrupt(): Promise<void> {
    if (!this.active) return
    this.interrupting = true
    for (const [id] of this.pending) this.deny(id, 'interrupted')
    this.write({ type: 'control_request', request_id: `int-${++this.reqN}`, request: { subtype: 'interrupt' } })
    const t0 = Date.now()
    while (this.active && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25))
    if (this.active) { this.active = false; this.hub.emit({ t: 'turn_end', reason: 'interrupted' }) }
  }

  respond(reqId: string, answer: PermDecision | string, reason?: string): void {
    const p = this.pending.get(reqId)
    if (!p) return
    this.pending.delete(reqId)
    let response: Obj
    if (p.question) {
      const questions = (p.input['questions'] as Obj[]) ?? []
      response = { behavior: 'allow', updatedInput: { ...p.input, answers: Object.fromEntries(questions.map((q) => [String(q['question']), answer])) } }
    } else if (answer === 'deny') {
      response = { behavior: 'deny', message: reason ? `The user denied this: ${reason}` : 'The user denied this action.' }
    } else {
      response = { behavior: 'allow', updatedInput: p.input, ...(answer === 'allow-chat' && p.suggestions ? { updatedPermissions: p.suggestions } : {}) }
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: reqId, response } })
    this.hub.emit({ t: 'status', phase: 'thinking' })
  }

  private deny(reqId: string, message: string): void {
    this.pending.delete(reqId)
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: reqId, response: { behavior: 'deny', message, interrupt: true } } })
  }

  setMode(mode: Mode): void {
    if (mode === 'dangerous' && !this.o.dangerousAllowed) return
    this.write({ type: 'control_request', request_id: `mode-${++this.reqN}`, request: { subtype: 'set_permission_mode', mode: MODE_FLAG[mode] } })
  }

  async dispose(): Promise<void> {
    this.hub.closed = true
    try { this.child.stdin.end() } catch { /* already closed */ }
    this.child.kill('SIGTERM')
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL') }, 1500).unref()
  }

  // ---- stream parsing ----

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try { this.onMessage(JSON.parse(line) as Obj) } catch (err) { if (!(err instanceof SyntaxError)) console.error('[claude]', err) }
    }
  }

  private onMessage(m: Obj): void {
    switch (m['type']) {
      case 'stream_event': return this.onStream(m['event'] as Obj)
      case 'assistant': return this.onAssistant(m['message'] as Obj)
      case 'user': return this.onUser(m['message'] as Obj)
      case 'control_request': return this.onControl(m)
      case 'result': return this.onResult(m)
      default: return // system, rate_limit_event, ...
    }
  }

  private onStream(e: Obj): void {
    const type = e['type']
    if (type === 'message_start') { this.msgId = String((e['message'] as Obj)['id']); return }
    if (type === 'content_block_start') {
      const b = e['content_block'] as Obj
      if (b['type'] === 'tool_use') this.emitTool(String(b['id']), String(b['name']), {}, false)
      return
    }
    if (type === 'content_block_delta') {
      const d = e['delta'] as Obj
      const idx = Number(e['index'] ?? 0)
      if (d['type'] === 'text_delta') { this.streamed.add(this.msgId); this.hub.emit({ t: 'text', id: `${this.msgId}:${idx}`, delta: String(d['text']) }) }
      else if (d['type'] === 'thinking_delta' && d['thinking']) this.hub.emit({ t: 'thinking', id: `${this.msgId}:${idx}`, delta: String(d['thinking']) })
    }
  }

  private onAssistant(msg: Obj): void {
    const id = String(msg['id'])
    for (const [i, b] of ((msg['content'] as Obj[]) ?? []).entries()) {
      if (b['type'] === 'tool_use') this.emitTool(String(b['id']), String(b['name']), (b['input'] ?? {}) as Obj, false)
      else if (b['type'] === 'text' && !this.streamed.has(id)) this.hub.emit({ t: 'text', id: `${id}:${i}`, delta: String(b['text']) })
    }
  }

  private emitTool(id: string, name: string, input: Obj, done: boolean, extra: Partial<Extract<AgentEvent, { t: 'tool' }>> = {}): void {
    const prev = this.tools.get(id)
    const d = describeTool(name, input)
    const ev: Extract<AgentEvent, { t: 'tool' }> = {
      t: 'tool', id, kind: toolKind(name), title: name,
      command: d.command || prev?.command, files: d.files ?? prev?.files, output: prev?.output, exit: prev?.exit, done, ...extra
    }
    this.tools.set(id, ev)
    if (!done) this.hub.emit({ t: 'status', phase: 'tool', detail: ev.command ?? ev.files?.[0]?.path ?? name, kind: ev.kind })
    this.hub.emit(ev)
  }

  private onUser(msg: Obj): void {
    const content = msg['content']
    if (!Array.isArray(content)) return
    for (const b of content as Obj[]) {
      if (b['type'] !== 'tool_result') continue
      const id = String(b['tool_use_id'])
      const prev = this.tools.get(id)
      const raw = b['content']
      const output = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw as Obj[]).map((c) => String(c['text'] ?? '')).join('\n') : ''
      this.emitTool(id, prev?.title ?? 'tool', {}, true, { output, exit: b['is_error'] ? 1 : 0 })
    }
  }

  private onControl(m: Obj): void {
    const req = m['request'] as Obj
    if (req['subtype'] !== 'can_use_tool') return
    const reqId = String(m['request_id'])
    const name = String(req['tool_name'])
    const input = (req['input'] ?? {}) as Obj
    const toolUseId = String(req['tool_use_id'] ?? '')
    if (name === 'AskUserQuestion') {
      const q = ((input['questions'] as Obj[]) ?? [])[0] ?? {}
      const prompt = String(q['question'] ?? 'The agent has a question')
      this.pending.set(reqId, { toolUseId, input, suggestions: null, question: { prompt } })
      this.hub.emit({ t: 'status', phase: 'waiting', detail: 'question' })
      this.hub.emit({ t: 'question', reqId, prompt, choices: ((q['options'] as Obj[]) ?? []).map((o) => String(o['label'])) })
      return
    }
    this.pending.set(reqId, { toolUseId, input, suggestions: req['permission_suggestions'] })
    const d = describeTool(name, input)
    const summary = d.command ?? d.files?.[0]?.path ?? String(req['description'] ?? name)
    if (name === 'ExitPlanMode' && input['plan']) this.hub.emit({ t: 'attachment', id: `plan-${reqId}`, kind: 'plan', name: 'Plan', body: String(input['plan']) })
    this.hub.emit({ t: 'status', phase: 'waiting', detail: summary })
    this.hub.emit({
      t: 'permission', reqId, tool: name, summary,
      options: [{ id: 'allow-once', label: 'Allow once' }, ...(req['permission_suggestions'] ? [{ id: 'allow-chat' as const, label: 'Allow for this chat' }] : []), { id: 'deny', label: 'Deny' }]
    })
  }

  private onResult(m: Obj): void {
    this.active = false
    const usage = (m['usage'] ?? {}) as Obj
    this.hub.emit({ t: 'usage', inputTokens: Number(usage['input_tokens'] ?? 0), outputTokens: Number(usage['output_tokens'] ?? 0), costUsd: typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : undefined })
    this.streamed.clear()
    if (this.interrupting) return void this.hub.emit({ t: 'turn_end', reason: 'interrupted' })
    if (m['is_error']) this.hub.emit({ t: 'turn_end', reason: 'error', error: String(m['result'] ?? m['subtype'] ?? 'error').split('\n')[0] })
    else this.hub.emit({ t: 'turn_end', reason: 'done' })
  }
}
