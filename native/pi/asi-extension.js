// ASI Messenger extension for Pi. Loaded with `pi -e`, it does two jobs Pi does not do itself:
//   1. permission gate: Pi runs every tool unprompted, so this asks ASI Messenger first, following the chat's mode
//   2. ASI tools: proxies ask_user, send_attachment, open_url, ... to the app's local MCP bridge
// Env: ASI_MODE_FILE (current mode, rewritten by the app), ASI_MCP_URL + ASI_MCP_TOKEN (optional).
import { readFileSync } from 'node:fs'
import http from 'node:http'

const MODES = new Set(['ask', 'auto-edit', 'plan', 'dangerous'])
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls'])
const EDITS = new Set(['edit', 'write'])

function currentMode() {
  try {
    const m = readFileSync(process.env.ASI_MODE_FILE, 'utf8').trim()
    return MODES.has(m) ? m : 'ask'
  } catch {
    return 'ask' // unreadable means locked down
  }
}

// plain http: fetch() would time out an ask_user that waits minutes for a human
function rpc(method, params, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(process.env.ASI_MCP_URL)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ASI_MCP_TOKEN}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const msg = JSON.parse(data)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        } catch { reject(new Error(`ASI bridge returned ${res.statusCode}`)) }
      })
    })
    req.on('error', reject)
    signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.end(body)
  })
}

export default async function asiExtension(pi) {
  const asiTools = new Set()
  if (process.env.ASI_MCP_URL && process.env.ASI_MCP_TOKEN) {
    try {
      const { tools } = await rpc('tools/list', {})
      for (const t of tools) {
        asiTools.add(t.name)
        pi.registerTool({
          name: t.name,
          label: t.name,
          description: t.description,
          promptSnippet: t.description,
          parameters: t.inputSchema,
          async execute(_id, params, signal) {
            const res = await rpc('tools/call', { name: t.name, arguments: params }, signal)
            const text = (res.content ?? []).map((c) => c.text ?? '').join('\n')
            if (res.isError) throw new Error(text)
            return { content: [{ type: 'text', text }], details: {} }
          }
        })
      }
    } catch (err) {
      console.error('[asi] could not reach the ASI bridge:', err.message)
    }
  }

  const allowedForChat = new Set()
  pi.on('tool_call', async (event, ctx) => {
    const name = event.toolName
    if (asiTools.has(name) || READ_ONLY.has(name)) return undefined
    const mode = currentMode()
    if (mode === 'dangerous') return undefined
    if (EDITS.has(name)) {
      if (mode === 'plan') return { block: true, reason: 'Plan mode is read-only. Describe the change in your plan instead of making it.' }
      if (mode === 'auto-edit') return undefined
    }
    if (allowedForChat.has(name)) return undefined
    const input = event.input ?? {}
    const summary = String(input.command ?? input.path ?? input.file_path ?? name)
    const options = name === 'bash' ? ['Allow once', 'Deny'] : ['Allow once', 'Allow for this chat', 'Deny']
    const choice = await ctx.ui.select(JSON.stringify({ asi: 'permission', tool: name, summary }), options)
    if (choice === 'Allow for this chat') allowedForChat.add(name)
    if (choice === 'Allow once' || choice === 'Allow for this chat') return undefined
    return { block: true, reason: 'The user denied this action.' }
  })
}
