import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { AttachmentKind } from '@shared/events'
import type { McpEndpoint } from '../harness/types'

type Obj = Record<string, unknown>

export interface BridgeActions {
  chatExists(chatId: string): Promise<boolean>
  askUser(chatId: string, question: string, choices?: string[]): Promise<string>
  sendAttachment(chatId: string, a: { name: string; kind: AttachmentKind; content?: string; path?: string }): Promise<void>
  openUrl(chatId: string, url: string): Promise<void>
  openDrawing(chatId: string, name?: string): Promise<void>
  setStatus(chatId: string, text: string): Promise<void>
}

const TOOLS = [
  {
    name: 'ask_user',
    description: 'Ask the human a question in their ASI Messenger chat and wait for the answer. Use it when you need a decision or missing information.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional quick-reply buttons' } }, required: ['question'] }
  },
  {
    name: 'send_attachment',
    description: 'Send the human a file-like attachment (markdown note, code, diff, plan) that they can open and reply to. Provide content, or a path inside the workspace.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['markdown', 'code', 'diff', 'plan', 'image'] }, content: { type: 'string' }, path: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'open_url',
    description: 'Show the human a web page (for example a local dev server) in the ASI Messenger browser window. Only http and https URLs.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'open_drawing',
    description: 'Open the workspace Excalidraw window so the human can sketch; optionally open a named drawing from .drawings.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } }
  },
  {
    name: 'set_status',
    description: 'Set a short status line (shown under your name in the contact list) describing what you are doing.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
]

const KINDS = new Set(['markdown', 'code', 'diff', 'plan', 'image'])
const ok = (text: string) => ({ content: [{ type: 'text', text }] })
const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Streamable-HTTP MCP server on 127.0.0.1, scoped per chat by URL and a per-launch bearer token. */
export function createMcpBridge(actions: BridgeActions) {
  const token = randomBytes(24).toString('hex')
  let server: Server | null = null
  let port = 0

  async function callTool(chatId: string, name: string, args: Obj): Promise<unknown> {
    try {
      switch (name) {
        case 'ask_user': {
          const q = String(args['question'] ?? '').trim()
          if (!q) return fail('question is required')
          const choices = Array.isArray(args['choices']) ? (args['choices'] as unknown[]).map(String).slice(0, 8) : undefined
          return ok(await actions.askUser(chatId, q, choices))
        }
        case 'send_attachment': {
          const n = String(args['name'] ?? '').trim()
          if (!n) return fail('name is required')
          const kind = (KINDS.has(String(args['kind'])) ? args['kind'] : n.endsWith('.md') ? 'markdown' : 'code') as AttachmentKind
          if (!args['content'] && !args['path']) return fail('provide content or path')
          await actions.sendAttachment(chatId, { name: n, kind, content: args['content'] ? String(args['content']) : undefined, path: args['path'] ? String(args['path']) : undefined })
          return ok('Sent to the human as an attachment.')
        }
        case 'open_url': {
          const url = String(args['url'] ?? '')
          if (!isHttpUrl(url)) return fail('only http and https URLs can be opened')
          await actions.openUrl(chatId, url)
          return ok(`Opened ${url} for the human.`)
        }
        case 'open_drawing':
          await actions.openDrawing(chatId, args['name'] ? String(args['name']) : undefined)
          return ok('Opened the drawing window.')
        case 'set_status': {
          const text = String(args['text'] ?? '').trim().slice(0, 80)
          if (!text) return fail('text is required')
          await actions.setStatus(chatId, text)
          return ok('Status updated.')
        }
        default:
          return fail(`unknown tool ${name}`)
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRpc(chatId: string, msg: Obj): Promise<Obj | null> {
    const id = msg['id']
    const method = String(msg['method'] ?? '')
    if (id === undefined) return null // notification
    const reply = (result: unknown): Obj => ({ jsonrpc: '2.0', id, result })
    const error = (code: number, message: string): Obj => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: String((msg['params'] as Obj | undefined)?.['protocolVersion'] ?? '2025-03-26'), capabilities: { tools: {} }, serverInfo: { name: 'asi-messenger', version: '0.1.0' }, instructions: 'Tools for talking to the human in ASI Messenger.' })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const p = (msg['params'] ?? {}) as Obj
        return reply(await callTool(chatId, String(p['name']), (p['arguments'] ?? {}) as Obj))
      }
      default:
        return error(-32601, `method not found: ${method}`)
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    // refuse DNS-rebinding style hosts and anything not carrying our token
    const host = (req.headers.host ?? '').split(':')[0]
    if (host !== '127.0.0.1' && host !== 'localhost') return send(403, { error: 'forbidden host' })
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' })
    const m = /^\/mcp\/([\w-]+)$/.exec(req.url ?? '')
    if (!m) return send(404, { error: 'not found' })
    const chatId = m[1]!
    if (req.method === 'DELETE') return send(200, {})
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
    if (!(await actions.chatExists(chatId))) return send(404, { error: 'unknown chat' })
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 2_000_000) return send(413, { error: 'too large' })
      chunks.push(c as Buffer)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'invalid json' }) }
    const batch = Array.isArray(body)
    const replies = (await Promise.all((batch ? (body as Obj[]) : [body as Obj]).map((m) => handleRpc(chatId, m)))).filter((r): r is Obj => r !== null)
    if (replies.length === 0) return send(202)
    send(200, batch ? replies : replies[0])
  }

  return {
    async start(): Promise<void> {
      server = createServer((req, res) => void onRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }))
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      port = (server!.address() as AddressInfo).port
    },
    endpointFor(chatId: string): McpEndpoint {
      return { url: `http://127.0.0.1:${port}/mcp/${chatId}`, token }
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    }
  }
}

export type McpBridge = ReturnType<typeof createMcpBridge>
