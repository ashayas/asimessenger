import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventHub } from '../emitter'
import type { AgentEvent, AgentSession, FileChange, PermDecision, ToolKind, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'

type Obj = Record<string, unknown>

export interface PiOptions {
  command: string
  env: NodeJS.ProcessEnv
  cwd: string
  mode: Mode
  dangerousAllowed: boolean
  /** Pi session file; created on first use, so it doubles as the resume id. */
  sessionFile: string
  /** Bundled ASI extension: permission gate + ASI tools. */
  extensionPath: string
  extraArgs?: string[]
  prefixArgs?: string[]
  mcp?: { url: string; token: string }
}

export function toolKind(name: string): ToolKind {
  if (name === 'bash') return 'exec'
  if (name === 'edit' || name === 'write') return 'edit'
  if (name === 'read' || name === 'ls') return 'read'
  if (name === 'grep' || name === 'find') return 'search'
  return 'mcp'
}

function describeTool(name: string, args: Obj): { command?: string; files?: FileChange[] } {
  if (name === 'bash') return { command: String(args['command'] ?? '') }
  const path = args['path'] ?? args['file_path']
  if (path) return { files: [{ path: String(path), added: 0, removed: 0 }] }
  if (args['pattern']) return { command: `${name} ${String(args['pattern'])}` }
  return {}
}

const textOf = (r: unknown): string => {
  const content = (r as Obj | undefined)?.['content']
  return Array.isArray(content) ? (content as Obj[]).map((c) => String(c['text'] ?? '')).join('\n') : ''
}

interface PendingUi { kind: 'permission' | 'question' | 'confirm'; options: string[] }

/** Pi over `pi --mode rpc` (JSONL on stdin/stdout). Pi has no permission system, so the bundled extension gates tools through extension_ui_request. */
export class PiSession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly resumeId: string
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private stderrTail = ''
  private msgN = 0
  private tools = new Map<string, Extract<AgentEvent, { t: 'tool' }>>()
  private pending = new Map<string, PendingUi>()
  private modeDir: string
  private modeFile: string
  private active = false
  private interrupting = false
  private lastError = ''

  constructor(private o: PiOptions) {
    this.resumeId = o.sessionFile
    this.modeDir = mkdtempSync(join(tmpdir(), 'asi-pi-'))
    this.modeFile = join(this.modeDir, 'mode')
    writeFileSync(this.modeFile, o.mode)
    const args = [...(o.prefixArgs ?? []), '--mode', 'rpc', '--session', o.sessionFile, '-e', o.extensionPath, ...(o.extraArgs ?? [])]
    const env: NodeJS.ProcessEnv = { ...o.env, ASI_MODE_FILE: this.modeFile }
    if (o.mcp) { env['ASI_MCP_URL'] = o.mcp.url; env['ASI_MCP_TOKEN'] = o.mcp.token }
    this.child = spawn(o.command, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d: string) => this.onData(d))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-1500) })
    this.child.on('error', (err) => this.fail(`failed to start pi: ${err.message}`))
    this.child.on('exit', (code, sig) => {
      if (this.hub.closed) return
      const tail = this.stderrTail.trim().split('\n').pop()
      this.fail(`pi exited (${sig ?? code})${tail ? `: ${tail}` : ''}`)
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
    const wasActive = this.active
    this.active = true
    this.interrupting = false
    this.lastError = ''
    this.hub.emit({ t: 'status', phase: 'thinking' })
    this.write({ type: 'prompt', message: text, ...(wasActive ? { streamingBehavior: 'steer' } : {}) })
  }

  async interrupt(): Promise<void> {
    if (!this.active) return
    this.interrupting = true
    for (const id of this.pending.keys()) this.write({ type: 'extension_ui_response', id, cancelled: true })
    this.pending.clear()
    this.write({ type: 'abort' })
    const t0 = Date.now()
    while (this.active && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25))
    if (this.active) { this.active = false; this.hub.emit({ t: 'turn_end', reason: 'interrupted' }) }
  }

  respond(reqId: string, answer: PermDecision | string): void {
    const p = this.pending.get(reqId)
    if (!p) return
    this.pending.delete(reqId)
    if (p.kind === 'permission') {
      const label = answer === 'allow-chat' ? 'Allow for this chat' : answer === 'allow-once' ? 'Allow once' : 'Deny'
      this.write({ type: 'extension_ui_response', id: reqId, value: p.options.includes(label) ? label : answer === 'deny' ? 'Deny' : 'Allow once' })
    } else if (p.kind === 'confirm') this.write({ type: 'extension_ui_response', id: reqId, confirmed: answer === 'Yes' })
    else this.write({ type: 'extension_ui_response', id: reqId, value: String(answer) })
    this.hub.emit({ t: 'status', phase: 'thinking' })
  }

  setMode(mode: Mode): void {
    if (mode === 'dangerous' && !this.o.dangerousAllowed) return
    writeFileSync(this.modeFile, mode)
  }

  async dispose(): Promise<void> {
    this.hub.closed = true
    try { this.child.stdin.end() } catch { /* already closed */ }
    this.child.kill('SIGTERM')
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL') }, 1500).unref()
    rmSync(this.modeDir, { recursive: true, force: true })
  }

  // ---- stream parsing (strict JSONL: split on \n only, never readline) ----

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      try { this.onMessage(JSON.parse(line) as Obj) } catch (err) { if (!(err instanceof SyntaxError)) console.error('[pi]', err) }
    }
  }

  private onMessage(m: Obj): void {
    switch (m['type']) {
      case 'response':
        if (m['command'] === 'prompt' && m['success'] === false) {
          this.active = false
          this.hub.emit({ t: 'turn_end', reason: 'error', error: String(m['error'] ?? 'pi rejected the prompt') })
        }
        return
      case 'message_start': if ((m['message'] as Obj)['role'] === 'assistant') this.msgN++; return
      case 'message_update': return this.onUpdate(m['assistantMessageEvent'] as Obj)
      case 'message_end': return this.onMessageEnd(m['message'] as Obj)
      case 'tool_execution_start': return this.emitTool(String(m['toolCallId']), String(m['toolName']), (m['args'] ?? {}) as Obj, false)
      case 'tool_execution_update': return this.emitTool(String(m['toolCallId']), String(m['toolName']), (m['args'] ?? {}) as Obj, false, { output: textOf(m['partialResult']) })
      case 'tool_execution_end': return this.emitTool(String(m['toolCallId']), String(m['toolName']), {}, true, { output: textOf(m['result']), exit: m['isError'] ? 1 : 0 })
      case 'agent_end': return this.onAgentEnd()
      case 'extension_ui_request': return this.onUi(m)
      default: return
    }
  }

  private onUpdate(e: Obj): void {
    const id = `pi${this.msgN}:${Number(e['contentIndex'] ?? 0)}`
    if (e['type'] === 'text_delta') this.hub.emit({ t: 'text', id, delta: String(e['delta']) })
    else if (e['type'] === 'thinking_delta' && e['delta']) this.hub.emit({ t: 'thinking', id, delta: String(e['delta']) })
  }

  private onMessageEnd(msg: Obj): void {
    if (msg['role'] !== 'assistant') return
    const u = (msg['usage'] ?? {}) as Obj
    const cost = (u['cost'] ?? {}) as Obj
    if (u['input'] !== undefined) this.hub.emit({ t: 'usage', inputTokens: Number(u['input'] ?? 0), outputTokens: Number(u['output'] ?? 0), costUsd: typeof cost['total'] === 'number' ? cost['total'] : undefined })
    if (msg['stopReason'] === 'error') this.lastError = String(msg['errorMessage'] ?? 'the model returned an error').split('\n')[0]!
  }

  private onAgentEnd(): void {
    if (!this.active && !this.interrupting) return
    this.active = false
    if (this.interrupting) return void this.hub.emit({ t: 'turn_end', reason: 'interrupted' })
    if (this.lastError) this.hub.emit({ t: 'turn_end', reason: 'error', error: this.lastError })
    else this.hub.emit({ t: 'turn_end', reason: 'done' })
  }

  private emitTool(id: string, name: string, args: Obj, done: boolean, extra: Partial<Extract<AgentEvent, { t: 'tool' }>> = {}): void {
    const prev = this.tools.get(id)
    const d = describeTool(name, args)
    const ev: Extract<AgentEvent, { t: 'tool' }> = {
      t: 'tool', id, kind: toolKind(name), title: prev?.title ?? name,
      command: d.command || prev?.command, files: d.files ?? prev?.files, output: prev?.output, exit: prev?.exit, done, ...extra
    }
    this.tools.set(id, ev)
    if (!done && !prev) this.hub.emit({ t: 'status', phase: 'tool', detail: ev.command ?? ev.files?.[0]?.path ?? name, kind: ev.kind })
    this.hub.emit(ev)
  }

  private onUi(m: Obj): void {
    const id = String(m['id'])
    const method = String(m['method'])
    const title = String(m['title'] ?? '')
    if (method === 'select') {
      const options = ((m['options'] as unknown[]) ?? []).map(String)
      let gate: Obj | null = null
      try { const p = JSON.parse(title) as Obj; if (p['asi'] === 'permission') gate = p } catch { /* another extension's dialog */ }
      if (gate) {
        this.pending.set(id, { kind: 'permission', options })
        const summary = String(gate['summary'])
        this.hub.emit({ t: 'status', phase: 'waiting', detail: summary })
        this.hub.emit({
          t: 'permission', reqId: id, tool: String(gate['tool']), summary,
          options: [{ id: 'allow-once', label: 'Allow once' }, ...(options.includes('Allow for this chat') ? [{ id: 'allow-chat' as const, label: 'Allow for this chat' }] : []), { id: 'deny', label: 'Deny' }]
        })
      } else {
        this.pending.set(id, { kind: 'question', options })
        this.hub.emit({ t: 'status', phase: 'waiting', detail: 'question' })
        this.hub.emit({ t: 'question', reqId: id, prompt: title, choices: options })
      }
    } else if (method === 'confirm') {
      this.pending.set(id, { kind: 'confirm', options: ['Yes', 'No'] })
      this.hub.emit({ t: 'status', phase: 'waiting', detail: 'question' })
      this.hub.emit({ t: 'question', reqId: id, prompt: [title, m['message']].filter(Boolean).join('\n'), choices: ['Yes', 'No'] })
    } else if (method === 'input' || method === 'editor') {
      this.pending.set(id, { kind: 'question', options: [] })
      this.hub.emit({ t: 'status', phase: 'waiting', detail: 'question' })
      this.hub.emit({ t: 'question', reqId: id, prompt: title })
    }
    // notify / setStatus / setWidget / setTitle are fire-and-forget; nothing to show
  }
}
