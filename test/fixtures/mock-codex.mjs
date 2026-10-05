#!/usr/bin/env node
// Mimics `codex app-server` (JSON-RPC lite: no "jsonrpc" field).
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const waiting = new Map()
let reqId = 0
let interrupted = false
const THREAD = 'thread-mock-1'
const note = (method, params) => out({ method, params })
const ask = (method, params) => new Promise((resolve) => { const id = reqId++; waiting.set(id, resolve); out({ id, method, params }) })
const item = (type, id, extra = {}) => ({ type, id, ...extra })

rl.on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.id != null && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return }
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'mock', codexHome: '/tmp' } })
  if (m.method === 'initialized') return
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: THREAD }, approvalPolicy: m.params.approvalPolicy } })
  if (m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: m.params.threadId } } })
  if (m.method === 'turn/interrupt') { interrupted = true; return out({ id: m.id, result: {} }) }
  if (m.method !== 'turn/start') return
  interrupted = false
  const turn = { id: 'turn-1', items: [], status: 'inProgress' }
  out({ id: m.id, result: { turn } })
  note('turn/started', { threadId: THREAD, turn })
  const imgs = m.params.input.filter((i) => i.type === 'localImage' && i.path).length
  const text = m.params.input.map((i) => i.text).join('') + (imgs ? ` [img:${imgs}]` : '')
  const finish = (status = 'completed', error = null) => note('turn/completed', { threadId: THREAD, turn: { ...turn, status, error } })
  if (text.includes('retitle')) note('thread/name/updated', { threadId: THREAD, threadName: 'Tidy the build script' })
  if (text.includes('slow')) {
    note('item/started', { item: item('commandExecution', 'c1', { command: 'sleep 30', cwd: '/tmp', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null }) })
    for (let i = 0; i < 300 && !interrupted; i++) await new Promise((r) => setTimeout(r, 50))
    return finish('interrupted')
  }
  if (text.includes('command')) {
    note('item/started', { item: item('commandExecution', 'c2', { command: 'rm -rf dist', cwd: '/tmp', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null }) })
    const r = await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'c2', command: 'rm -rf dist', startedAtMs: 1 })
    note('item/completed', { item: item('commandExecution', 'c2', { command: 'rm -rf dist', cwd: '/tmp', status: r.decision.startsWith('accept') ? 'completed' : 'declined', aggregatedOutput: 'removed', exitCode: r.decision.startsWith('accept') ? 0 : null, durationMs: 12 }) })
    note('item/started', { item: item('agentMessage', 'a1', { text: '' }) })
    note('item/agentMessage/delta', { itemId: 'a1', delta: `decision=${r.decision}` })
    note('item/completed', { item: item('agentMessage', 'a1', { text: `decision=${r.decision}` }) })
    return finish()
  }
  if (text.includes('patch')) {
    note('item/started', { item: item('fileChange', 'f1', { changes: [{ path: '/tmp/x.txt', kind: { type: 'add' }, diff: '+hi\n+there\n' }], status: 'inProgress' }) })
    const r = await ask('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'f1', startedAtMs: 1 })
    note('item/completed', { item: item('fileChange', 'f1', { changes: [{ path: '/tmp/x.txt', kind: { type: 'add' }, diff: '+hi\n+there\n' }], status: r.decision === 'decline' ? 'declined' : 'completed' }) })
    return finish()
  }
  if (text.includes('question')) {
    const r = await ask('item/tool/requestUserInput', { threadId: THREAD, turnId: 'turn-1', itemId: 'q1', questions: [{ id: 'q', header: 'h', question: 'Which lock?', isOther: false, isSecret: false, options: [{ label: 'Per tab', description: '' }, { label: 'Global', description: '' }] }], isBlocking: true })
    note('item/completed', { item: item('agentMessage', 'a2', { text: `answers=${JSON.stringify(r.answers)}` }) })
    return finish()
  }
  if (text.includes('fail')) return finish('failed', { message: 'model overloaded' })
  note('item/started', { item: item('agentMessage', 'a0', { text: '' }) })
  note('item/agentMessage/delta', { itemId: 'a0', delta: 'PO' })
  note('item/agentMessage/delta', { itemId: 'a0', delta: `NG: ${text}` })
  note('item/completed', { item: item('agentMessage', 'a0', { text: `PONG: ${text}` }) })
  note('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 4, outputTokens: 2 } } })
  finish()
})
