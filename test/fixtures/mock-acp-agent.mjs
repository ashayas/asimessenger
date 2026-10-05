#!/usr/bin/env node
// Tiny ACP agent for tests. Prompt text selects the behavior: "tool", "permission", "plan", "slow", otherwise echo.
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const upd = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } })
let nextId = 1000
const waiting = new Map()
let cancelled = false
let loadedSessions = new Set()

rl.on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: !process.argv.includes('--no-images') } }, authMethods: [] } })
  if (m.method === 'session/new') return out({ id: m.id, result: { sessionId: 'mock-session-1' } })
  if (m.method === 'session/load') {
    loadedSessions.add(m.params.sessionId)
    upd(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } })
    return out({ id: m.id, result: null })
  }
  if (m.method === 'session/set_mode') return out({ id: m.id, result: null })
  if (m.method === 'session/cancel') { cancelled = true; return }
  if (m.id != null && !m.method) { waiting.get(m.id)?.(m.result); return }
  if (m.method === 'session/prompt') {
    cancelled = false
    const sid = m.params.sessionId
    const imgs = m.params.prompt.filter((b) => b.type === 'image' && b.mimeType === 'image/png' && b.data).length
    const text = m.params.prompt.map((b) => b.text).join('') + (imgs ? ` [img:${imgs}]` : '')
    const end = (stopReason = 'end_turn') => out({ id: m.id, result: { stopReason, usage: { inputTokens: 5, outputTokens: 2 } } })
    if (text.includes('retitle')) upd(sid, { sessionUpdate: 'session_info_update', title: 'Fix the flaky session test' })
    if (text.includes('slow')) {
      upd(sid, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'sleep', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep 30' } })
      for (let i = 0; i < 300 && !cancelled; i++) await new Promise((r) => setTimeout(r, 100))
      return end(cancelled ? 'cancelled' : 'end_turn')
    }
    if (text.includes('plan')) {
      upd(sid, { sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'completed', priority: 'high' }, { content: 'step two', status: 'pending', priority: 'low' }] })
      return end()
    }
    if (text.includes('permission')) {
      const id = nextId++
      const answer = await new Promise((resolve) => {
        waiting.set(id, resolve)
        out({ id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'p1', title: 'bash', kind: 'execute', rawInput: { command: 'rm -rf dist' } },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } })
      })
      const sel = answer?.outcome?.optionId
      upd(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: `permission answer: ${sel ?? answer?.outcome?.outcome}` } })
      return end()
    }
    if (text.includes('tool')) {
      upd(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } })
      upd(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', status: 'pending', rawInput: {} })
      upd(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', rawInput: { command: 'echo hi' } })
      upd(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] })
      upd(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'ran it' } })
      return end()
    }
    upd(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm0', content: { type: 'text', text: 'PO' } })
    upd(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm0', content: { type: 'text', text: `NG: ${text}` } })
    return end()
  }
})
