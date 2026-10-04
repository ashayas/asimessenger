import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export class RpcFailure extends Error {
  constructor(public readonly rpc: RpcError) {
    super(rpc.message)
  }
}

type Json = Record<string, unknown>

/** Minimal newline-delimited JSON-RPC 2.0 peer over a child's stdio (what ACP uses). */
export class RpcPeer {
  private nextId = 1
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private buf = ''
  private requestHandler: ((method: string, params: unknown) => Promise<unknown> | unknown) | null = null
  private notificationHandler: ((method: string, params: unknown) => void) | null = null
  private closeHandler: ((reason: string) => void) | null = null
  closed = false
  /** Last chunk of stderr, kept for error messages. */
  stderrTail = ''

  constructor(private child: ChildProcessWithoutNullStreams, private opts: { jsonrpcField?: boolean } = {}) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => this.onData(d))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2000) })
    child.on('error', (err) => this.shutdown(`failed to start: ${err.message}`))
    child.on('exit', (code, sig) => this.shutdown(`process exited (${sig ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ''}`))
  }

  onRequest(h: (method: string, params: unknown) => Promise<unknown> | unknown): void { this.requestHandler = h }
  onNotification(h: (method: string, params: unknown) => void): void { this.notificationHandler = h }
  onClose(h: (reason: string) => void): void { this.closeHandler = h }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ method, params })
  }

  kill(): void {
    this.closed = true
    this.child.kill('SIGTERM')
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL') }, 1500).unref()
  }

  private write(msg: Json): void {
    const out = this.opts.jsonrpcField === false ? msg : { jsonrpc: '2.0', ...msg }
    this.child.stdin.write(JSON.stringify(out) + '\n')
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: Json
      try { msg = JSON.parse(line) as Json } catch { continue } // agents may log non-JSON to stdout
      void this.dispatch(msg)
    }
  }

  private async dispatch(msg: Json): Promise<void> {
    const method = msg['method'] as string | undefined
    const id = msg['id'] as number | string | undefined
    if (method && id !== undefined) {
      try {
        const result = (await this.requestHandler?.(method, msg['params'])) ?? null
        this.write({ id, result })
      } catch (err) {
        this.write({ id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
      }
    } else if (method) {
      this.notificationHandler?.(method, msg['params'])
    } else if (typeof id === 'number') {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (msg['error']) p.reject(new RpcFailure(msg['error'] as RpcError))
      else p.resolve(msg['result'])
    }
  }

  private shutdown(reason: string): void {
    if (this.closed && this.pending.size === 0) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
    this.closeHandler?.(reason)
  }
}
