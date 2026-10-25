import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventHub } from '../emitter'
import { addRule, cleanupStaleRules, defaultSettingsPath, removeRule, ruleFromDenial } from './rules'
import type { AgentEvent, AgentSession, FileChange, PermDecision, ToolKind, UserTurn } from '@shared/events'
import type { Mode } from '@shared/models'

type Obj = Record<string, unknown>

export interface AgySessionOptions {
  command: string
  env: NodeJS.ProcessEnv
  cwd: string
  mode: Mode
  dangerousAllowed: boolean
  resumeId?: string | null
  extraArgs?: string[]
  /** Arguments placed before agy's own (tests run a node script through this). */
  prefixArgs?: string[]
  /** Where agy keeps its settings (permission allow-rules). Tests point this at a temp file. */
  settingsPath?: string
}

const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit'])
const EXEC_TOOLS = new Set(['run_command', 'send_command_input'])
const READ_TOOLS = new Set(['view_file', 'list_dir', 'read_url_content', 'read_resource', 'list_resources'])
const SEARCH_TOOLS = new Set(['grep_search', 'find_by_name', 'search_web', 'search_marketplace'])

export function toolKind(name: string): ToolKind {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (EXEC_TOOLS.has(name)) return 'exec'
  if (READ_TOOLS.has(name)) return 'read'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (name.startsWith('browser_') || name === 'open_browser_url' || name === 'read_browser_page') return 'web'
  return 'mcp'
}

function describeTool(name: string, params: Obj): { command?: string; files?: FileChange[] } {
  if (name === 'run_command') return { command: String(params['CommandLine'] ?? '') }
  const path = params['TargetFile'] ?? params['AbsolutePath'] ?? params['NotebookPath'] ?? params['SearchPath'] ?? params['DirectoryPath'] ?? params['Path']
  if (path) return { files: [{ path: String(path), added: 0, removed: 0 }] }
  if (params['Query'] ?? params['Pattern']) return { command: `${name} ${String(params['Query'] ?? params['Pattern'])}` }
  if (params['Url'] ?? params['URL']) return { command: String(params['Url'] ?? params['URL']) }
  return {}
}

interface Denial { rule: string; tool: string; summary: string; kind: 'edit' | 'exec' | 'other' }

/**
 * Antigravity CLI (`agy`) over its stream-json mode. Headless agy cannot prompt, so permissions work like this: a denied action is
 * reported at the end of the turn, shown as a card, and an approval adds that exact allow-rule, resumes the conversation in a fresh
 * process and asks the agent to retry. Auto-edit uses the native accept-edits mode and still asks about commands; Dangerous skips permissions.
 */
export class AgySession implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly restartOnModeChange = true
  conversationId = ''
  private child!: ChildProcessWithoutNullStreams
  private buf = ''
  private stderrTail = ''
  private active = false
  private interrupting = false
  private denials: Denial[] = []
  /** Cards waiting on you, and what an approval would add. */
  private pending = new Map<string, Denial>()
  /** Rules held for this session (allow for this chat) and for the turn in flight (allow once). */
  private chatRules = new Set<string>()
  private turnRules = new Set<string>()
  private restartBeforeSend = false
  private streamedText = false
  private previousUsage: Record<string, number> = {}
  private stepUsage = new Map<number, Obj>()
  private usageBaselineKnown = false
  private operations: Promise<void> = Promise.resolve()
  private approvalQueue: { denial: Denial; forChat: boolean }[] = []
  private cancelInit: (() => void) | null = null
  private initWaiter: ((id: string) => void) | null = null
  private settings: string

  private constructor(private o: AgySessionOptions) { this.settings = o.settingsPath ?? defaultSettingsPath(); this.usageBaselineKnown = !o.resumeId }

  get resumeId(): string { return this.conversationId }
  get busy(): boolean { return this.active }

  static async create(o: AgySessionOptions): Promise<AgySession> {
    const s = new AgySession(o)
    await cleanupStaleRules(s.settings).catch(() => {})
    await s.launch(o.resumeId || null)
    return s
  }

  private args(resume: string | null): string[] {
    const mode = this.o.mode === 'dangerous' && this.o.dangerousAllowed ? ['--dangerously-skip-permissions'] : this.o.mode === 'plan' ? ['--mode', 'plan'] : this.o.mode === 'auto-edit' ? ['--mode', 'accept-edits'] : []
    return [...(this.o.prefixArgs ?? []), '--input-format', 'stream-json', '--output-format', 'stream-json', '-p=', ...mode, ...(resume ? ['--conversation', resume] : []), ...(this.o.extraArgs ?? [])]
  }

  /** Start (or restart) the process and wait for its init line, which carries the conversation id. */
  private async launch(resume: string | null): Promise<void> {
    if (this.o.mode === 'dangerous' && !this.o.dangerousAllowed) throw new Error('dangerous mode is not enabled for this friend')
    if (this.hub.closed) throw new Error('agy session is closed')
    this.buf = ''
    this.stderrTail = ''
    const child = spawn(this.o.command, this.args(resume), { cwd: this.o.cwd, env: this.o.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { if (this.child === child) this.onData(d) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { if (this.child !== child) return; this.stderrTail = (this.stderrTail + d).slice(-1500) })
    child.on('error', (err) => { if (this.child === child) this.fail(`failed to start agy: ${err.message}`) })
    child.stdin.on('error', (err) => { if (this.child === child) this.fail(`agy input failed: ${err.message}`) })
    child.on('close', (code, sig) => {
      if (this.child !== child || this.hub.closed) return
      const tail = this.stderrTail.trim().split('\n').pop()
      this.fail(`agy exited (${sig ?? code})${tail ? `: ${tail}` : ''}`)
    })
    const id = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(t)
        this.initWaiter = null
        this.cancelInit = null
        child.off('error', onError)
        child.off('close', onClose)
      }
      const fail = (error: Error) => { cleanup(); reject(error) }
      const onError = (error: Error) => fail(new Error(`failed to start agy: ${error.message}`))
      const onClose = () => fail(new Error(`agy exited before it started${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ''}`))
      const t = setTimeout(() => fail(new Error(`agy did not start${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ' (is it signed in? run agy once in a terminal)'}`)), 20_000)
      this.initWaiter = (cid) => { cleanup(); resolve(cid) }
      this.cancelInit = () => fail(new Error('agy session is closed'))
      child.once('error', onError)
      child.once('close', onClose)
    }).catch((e: unknown) => { this.stopChild(child); throw e })
    this.conversationId = id
  }

  private fail(error: string): void {
    if (!this.active) return
    this.restartBeforeSend = true
    this.operations = this.operations.then(async () => {
      await this.dropRules([...this.turnRules])
      if (!this.active) return
      this.active = false
      this.hub.emit(this.interrupting ? { t: 'turn_end', reason: 'interrupted' } : { t: 'turn_end', reason: 'error', error })
    })
  }

  private write(obj: Obj): void {
    // not `child.killed`: that turns true after ANY signal, including the SIGINT we use to stop a turn while the process lives on
    if (this.hub.closed || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdin.writable) throw new Error('agy process is not running')
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  private say(text: string): void {
    this.write({ event: 'user', message: { content: text } })
  }

  send(turn: UserTurn): void {
    if (turn.images?.length) throw new Error('Antigravity stream-json supports text only. Attach a file path for the agent to read instead.')
    const text = turn.quote ? `Quoting ${turn.quote.name}:\n${turn.quote.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${turn.text}` : turn.text
    if (this.active) throw new Error('agy is already running a turn')
    this.active = true
    this.interrupting = false
    this.denials = []
    this.pending.clear()
    this.approvalQueue = []
    this.streamedText = false
    this.stepUsage.clear()
    this.hub.emit({ t: 'status', phase: 'thinking' })
    this.operations = this.operations.then(async () => {
      if (this.interrupting || this.hub.closed) return
      if (this.restartBeforeSend || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdin.writable) {
        this.stopChild(this.child)
        await this.launch(this.conversationId)
        this.restartBeforeSend = false
      }
      if (!this.interrupting && !this.hub.closed) this.say(text)
    }).catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)))
  }

  async interrupt(): Promise<void> {
    this.pending.clear()
    this.approvalQueue = []
    if (!this.active) return
    this.interrupting = true
    this.cancelInit?.()
    this.child.kill('SIGINT') // stops the turn; the process stays up for the next one
    const t0 = Date.now()
    while (this.active && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25))
    if (this.active) {
      this.stopChild(this.child)
      this.restartBeforeSend = true
      await this.dropRules([...this.turnRules])
      this.active = false
      this.hub.emit({ t: 'turn_end', reason: 'interrupted' })
    }
  }

  respond(reqId: string, answer: PermDecision | string): void {
    const d = this.pending.get(reqId)
    if (!d) return
    this.pending.delete(reqId)
    if (answer === 'deny') return void this.hub.emit({ t: 'status', phase: 'idle' })
    if (answer !== 'allow-once' && answer !== 'allow-chat') return
    this.approvalQueue.push({ denial: d, forChat: answer === 'allow-chat' })
    this.operations = this.operations.then(() => this.approveNext())
  }

  private async approveNext(): Promise<void> {
    if (this.active || this.hub.closed) return
    const next = this.approvalQueue.shift()
    if (next) await this.approve([next.denial], next.forChat)
  }

  /** Add the approved rules, restart so agy reads them, and ask it to try again. */
  private async approve(ds: Denial[], forChat: boolean): Promise<void> {
    try {
      if (this.hub.closed) return
      this.active = true
      this.streamedText = false
      this.stepUsage.clear()
      this.interrupting = false
      this.hub.emit({ t: 'status', phase: 'thinking' })
      for (const d of ds) {
        if (!this.chatRules.has(d.rule) && !this.turnRules.has(d.rule)) {
          await addRule(this.settings, d.rule)
          ;(forChat ? this.chatRules : this.turnRules).add(d.rule)
        }
      }
      this.stopChild(this.child)
      await this.launch(this.conversationId)
      this.restartBeforeSend = false
      this.denials = []
      this.say(`Permission was granted for exactly ${ds.length === 1 ? 'this action' : 'these actions'}: ${ds.map((d) => d.summary).join('; ')}. Please retry ${ds.length === 1 ? 'it' : 'them'} now.`)
    } catch (err) {
      await this.dropRules([...this.turnRules])
      this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  setMode(): void { /* the mode is a launch flag: the manager starts a new session instead (restartOnModeChange) */ }

  private stopChild(child: ChildProcessWithoutNullStreams): void {
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 1500).unref()
  }

  async dispose(): Promise<void> {
    this.hub.closed = true
    this.cancelInit?.()
    this.stopChild(this.child)
    await this.operations
    await this.dropRules([...this.turnRules, ...this.chatRules])
  }

  private async dropRules(rules: string[]): Promise<void> {
    for (const r of rules) await removeRule(this.settings, r).catch(() => {})
    for (const r of rules) { this.turnRules.delete(r); this.chatRules.delete(r) }
  }

  // ---- stream parsing ----

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line.startsWith('{')) continue // agy also prints plain warnings; the JSON stream is what we read
      try { this.onMessage(JSON.parse(line) as Obj) } catch (err) { if (!(err instanceof SyntaxError)) console.error('[agy]', err) }
    }
  }

  private onMessage(m: Obj): void {
    if (m['event'] === 'init') { if (typeof m['conversation_id'] === 'string' && m['conversation_id']) this.initWaiter?.(m['conversation_id']); return }
    if (m['event'] === 'step_update') return this.onStep(m['step_update'] as Obj)
    if (m['event'] === 'result') this.operations = this.operations.then(() => this.onResult((m['result'] ?? {}) as Obj)).catch((err: unknown) => this.fail(String(err)))
  }

  private tools = new Map<number, Extract<AgentEvent, { t: 'tool' }>>()
  private ruleCandidates = new Map<number, { action: string; denial: Denial }>()

  private onStep(s: Obj): void {
    const idx = Number(s['step_index'] ?? 0)
    const type = String(s['step_type'] ?? '')
    const state = String(s['state'] ?? '')
    if (s['usage'] && typeof s['usage'] === 'object') this.stepUsage.set(idx, s['usage'] as Obj)
    if (type === 'agent_response') {
      const delta = typeof s['text_delta'] === 'string' ? s['text_delta'] : ''
      if (delta) { this.streamedText = true; this.hub.emit({ t: 'text', id: `agy:${this.conversationId}:${idx}`, delta }) }
      return
    }
    if (/thinking|thought/i.test(type)) {
      if (typeof s['text_delta'] === 'string' && s['text_delta']) this.hub.emit({ t: 'thinking', id: `agy:${this.conversationId}:${idx}`, delta: s['text_delta'] })
      return
    }
    if (type !== 'tool') return
    const info = (s['tool_info'] ?? {}) as Obj
    const name = String(s['tool_name'] ?? info['name'] ?? 'tool')
    const params = (info['parameters'] ?? {}) as Obj
    const d = describeTool(name, params)
    const action = name === 'run_command' ? 'command' : EDIT_TOOLS.has(name) ? 'write_file' : null
    const target = action === 'command' ? d.command : d.files?.[0]?.path
    if (action && target) this.ruleCandidates.set(idx, {
      action, denial: { rule: `${action}(${target})`, tool: name, summary: target, kind: action === 'command' ? 'exec' : 'edit' }
    })
    const prev = this.tools.get(idx)
    const err = (info['error'] ?? null) as Obj | null
    const message = err ? String(err['message'] ?? '') : ''
    const rule = message ? ruleFromDenial(message) : null
    const ev: Extract<AgentEvent, { t: 'tool' }> = {
      t: 'tool', id: `agy:${this.conversationId}:${idx}`, kind: toolKind(name), title: name,
      command: d.command || prev?.command, files: d.files ?? prev?.files,
      done: state === 'DONE' || state === 'ERROR',
      output: typeof info['output'] === 'string' ? info['output'] : prev?.output,
      durationMs: typeof s['duration_seconds'] === 'number' ? s['duration_seconds'] * 1000 : prev?.durationMs,
      ...(state === 'ERROR' || err ? { exit: 1, output: rule ? `Not allowed yet: ${rule}` : message.split('\n')[0] } : {})
    }
    this.tools.set(idx, ev)
    if (state === 'ACTIVE' && !prev) this.hub.emit({ t: 'status', phase: 'tool', detail: ev.command ?? ev.files?.[0]?.path ?? name, kind: ev.kind })
    this.hub.emit(ev)
    if (rule) {
      const kind = toolKind(name)
      this.denials.push({ rule, tool: name, kind: kind === 'edit' ? 'edit' : kind === 'exec' ? 'exec' : 'other', summary: ev.command ?? ev.files?.[0]?.path ?? name })
    }
  }

  private async onResult(r: Obj): Promise<void> {
    if (!this.active || this.hub.closed) return
    if (!this.streamedText && typeof r['response'] === 'string' && r['response']) this.hub.emit({ t: 'text', id: `agy:${this.conversationId}:result`, delta: r['response'] })
    const u = (r['usage'] ?? {}) as Obj
    const delta = (key: string): number => {
      if (!(key in u)) return 0
      const total = Number(u[key])
      if (!Number.isFinite(total) || total < 0) return 0
      const previous = this.previousUsage[key] ?? 0
      this.previousUsage[key] = total
      return total >= previous ? total - previous : total
    }
    // Result counters span the entire conversation, including process restarts. Step usage is
    // per model call and lets a newly resumed adapter report only this turn's spend.
    const totals = { inputTokens: delta('input_tokens'), outputTokens: delta('output_tokens'), cacheReadTokens: delta('cache_read_tokens') || undefined }
    if (this.stepUsage.size) {
      const sum = (key: string) => [...this.stepUsage.values()].reduce((n, usage) => n + (Number(usage[key]) || 0), 0)
      this.hub.emit({ t: 'usage', inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cacheReadTokens: sum('cache_read_tokens') || undefined })
    } else if (this.usageBaselineKnown) this.hub.emit({ t: 'usage', ...totals })
    this.usageBaselineKnown = true
    this.stepUsage.clear()
    if (this.turnRules.size) this.restartBeforeSend = true // the running CLI may have cached its allow-rules
    await this.dropRules([...this.turnRules])
    // Newer Agy releases put denials only on the result. A DONE step alone is not evidence of execution.
    const deniedActions = Array.isArray(r['denied_actions']) ? r['denied_actions'] as Obj[] : []
    const deniedNames = new Set(deniedActions.map((a) => String(a['action'])))
    for (const [idx, tool] of this.tools) {
      const candidate = this.ruleCandidates.get(idx)
      if (candidate && deniedNames.has(candidate.action) && (!tool.output || /permission check failed|user denied|permission denied/i.test(tool.output))) {
        this.denials.push(candidate.denial)
        this.hub.emit({ ...tool, done: true, exit: undefined, output: `Not allowed yet: ${candidate.denial.rule}` })
      } else if (tool.exit === 1) {
        continue
      } else if (tool.done && !deniedActions.length) {
        this.hub.emit({ ...tool, exit: 0 })
      } else if (tool.done && tool.output) {
        this.hub.emit({ ...tool, exit: 0 })
      }
    }
    this.tools.clear()
    this.ruleCandidates.clear()
    if (this.interrupting || r['status'] === 'CANCELED' || r['status'] === 'INTERRUPTED') { this.active = false; this.denials = []; return void this.hub.emit({ t: 'turn_end', reason: 'interrupted' }) }
    const denied = [...new Map(this.denials.map((d) => [d.rule, d])).values()]
    this.denials = []
    this.active = false
    if (r['status'] && r['status'] !== 'SUCCESS') this.hub.emit({ t: 'turn_end', reason: 'error', error: String(r['error'] ?? r['status']).split('\n')[0] })
    else if (deniedActions.length && !denied.length) this.hub.emit({ t: 'turn_end', reason: 'error', error: `Antigravity denied ${[...deniedNames].join(', ')}. Its headless protocol did not provide enough detail to request a scoped approval.` })
    else this.hub.emit({ t: 'turn_end', reason: 'done' })
    for (const d of denied) {
      if ([...this.pending.values()].some((p) => p.rule === d.rule) || this.approvalQueue.some((p) => p.denial.rule === d.rule)) continue
      const reqId = `agy-perm-${randomUUID()}`
      this.pending.set(reqId, d)
      this.hub.emit({ t: 'status', phase: 'waiting', detail: d.summary })
      this.hub.emit({
        t: 'permission', reqId, tool: d.kind === 'edit' ? 'edit' : d.kind === 'exec' ? 'exec' : d.tool, summary: d.summary,
        options: [{ id: 'allow-once', label: 'Allow once, then retry' }, { id: 'allow-chat', label: 'Allow for this chat' }, { id: 'deny', label: 'Deny' }]
      })
    }
    await this.approveNext()
  }
}
