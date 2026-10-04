// Minimal stand-in for `pi --mode rpc`: just enough protocol for the adapter tests.
import { readFileSync } from 'node:fs'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const modeFile = process.env.ASI_MODE_FILE
let waiting = null
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
const asst = (extra = {}) => ({ role: 'assistant', content: [], stopReason: 'stop', usage: { input: 10, output: 5, cost: { total: 0.001 } }, ...extra })
function finish(message = asst()) {
  out({ type: 'message_end', message })
  out({ type: 'agent_end', messages: [] })
}
function handle(m) {
  if (m.type === 'abort') { if (waiting) return; out({ type: 'response', command: 'abort', success: true }); return finish(asst({ stopReason: 'aborted' })) }
  if (m.type === 'extension_ui_response') {
    const w = waiting; waiting = null
    if (!w) return
    const allowed = m.value && m.value !== 'Deny'
    out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: allowed ? 'ran' : 'blocked' }] }, isError: !allowed })
    return finish()
  }
  if (m.type !== 'prompt') return
  if (m.message.includes('REJECT')) return out({ type: 'response', command: 'prompt', success: false, error: 'no model configured' })
  out({ type: 'response', command: 'prompt', success: true })
  out({ type: 'agent_start' })
  out({ type: 'message_start', message: asst() })
  out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } })
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'echo: ' + m.message } })
  if (m.message.includes('FAIL')) return finish(asst({ stopReason: 'error', errorMessage: 'rate limited\nretry later' }))
  if (m.message.includes('BASH')) {
    out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'echo hi' } })
    const mode = readFileSync(modeFile, 'utf8').trim()
    out({ type: 'mode', mode })
    if (mode === 'dangerous') { out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ran' }] }, isError: false }); return finish() }
    waiting = true
    return out({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: JSON.stringify({ asi: 'permission', tool: 'bash', summary: 'echo hi' }), options: ['Allow once', 'Deny'] })
  }
  if (m.message.includes('SLOW')) return // never finishes until aborted
  finish()
}
