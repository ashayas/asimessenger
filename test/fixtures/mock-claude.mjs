#!/usr/bin/env node
// Mimics `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`.
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const sid = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : process.argv[process.argv.indexOf('--session-id') + 1]
let interrupted = false
let turnN = 0
const waiting = new Map()
const delta = (idx, text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } } })
const startMsg = (id) => out({ type: 'stream_event', event: { type: 'message_start', message: { id } } })

rl.on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') { interrupted = true; return }
  if (m.type === 'control_response') { waiting.get(m.response.request_id)?.(m.response.response); return }
  if (m.type !== 'user') return
  interrupted = false
  const imgs = m.message.content.filter((b) => b.type === 'image' && b.source?.type === 'base64' && b.source.media_type === 'image/png').length
  const text = m.message.content.map((b) => b.text).join('') + (imgs ? ` [img:${imgs}]` : '')
  out({ type: 'system', subtype: 'init', session_id: sid })
  const result = (extra = {}) => {
    turnN++
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 4102444800, rateLimitType: 'five_hour', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.3 + turnN / 100, resetsAt: 4102444800 }, seven_day: { utilization: 0.5, resetsAt: 4102876800 } } }, session_id: sid })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, total_cost_usd: 0.001 * turnN, modelUsage: { 'claude-haiku-4-5': {} }, ...extra })
  }
  if (text.includes('slow')) {
    startMsg('msg_slow')
    for (let i = 0; i < 300 && !interrupted; i++) { delta(0, '.'); await new Promise((r) => setTimeout(r, 50)) }
    return result({ subtype: 'error_during_execution', is_error: true, result: 'interrupted' })
  }
  if (text.includes('perm')) {
    out({ type: 'assistant', message: { id: 'msg_p', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf dist' } }] } })
    out({ type: 'control_request', request_id: 'cr1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf dist' }, tool_use_id: 'tu1', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } })
    const resp = await new Promise((r) => waiting.set('cr1', r))
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: resp.behavior === 'allow' ? 'removed' : resp.message, is_error: resp.behavior !== 'allow' }] } })
    startMsg('msg_p2'); delta(0, `behavior=${resp.behavior}${resp.updatedPermissions ? '+perms' : ''}`)
    return result()
  }
  if (text.includes('ask')) {
    out({ type: 'control_request', request_id: 'cr2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which lock?', options: [{ label: 'Per tab' }, { label: 'Global' }] }] }, tool_use_id: 'tu2' } })
    const resp = await new Promise((r) => waiting.set('cr2', r))
    startMsg('msg_q'); delta(0, `answers=${JSON.stringify(resp.updatedInput.answers)}`)
    return result()
  }
  startMsg('msg_1'); delta(0, 'PO'); delta(0, `NG: ${text}`)
  out({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: `PONG: ${text}` }] } })
  result()
})
