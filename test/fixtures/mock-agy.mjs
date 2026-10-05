// Mimics `agy --input-format stream-json --output-format stream-json -p=` closely enough for the adapter tests:
// init with a conversation id, turns as {"event":"user","message":{"content":...}}, tool steps, permission denials driven by the
// allow-rules in MOCK_AGY_SETTINGS, SIGINT ending the turn, and the launch flags echoed back on request.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
const convo = val('--conversation') ?? `conv-${process.pid}`
const dangerous = flag('--dangerously-skip-permissions')
const settingsPath = process.env.MOCK_AGY_SETTINGS
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const allowed = () => { try { return JSON.parse(readFileSync(settingsPath, 'utf8')).permissions?.allow ?? [] } catch { return [] } }
const realish = (p) => { const abs = resolve(p); try { return realpathSync(abs) } catch { try { return resolve(realpathSync(dirname(abs)), abs.split('/').pop()) } catch { return abs } } }

let step = 0
let turnN = 0
/** what a real model would redo when told "permission was granted, retry" */
const statePath = process.env.MOCK_AGY_SETTINGS ? `${process.env.MOCK_AGY_SETTINGS}.${convo}.state` : null // a resumed process remembers the conversation, like the real one
let lastActions = (() => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return [] } })()
let running = null
process.on('SIGINT', () => { if (running) running() })
process.stderr.write('warning: mock agy starting\n')
out({ event: 'init', conversation_id: convo, init: { cwd: process.cwd(), tools: [], permission_mode: dangerous ? 'always-proceed' : 'request-review' } })

const su = (s) => out({ event: 'step_update', step_update: { conversation_id: convo, ...s } })
const text = (t) => su({ step_index: step++, state: 'DONE', step_type: 'agent_response', text_delta: t })

async function tool(name, params, rule) {
  const i = step++
  su({ step_index: i, state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params } })
  if (dangerous || allowed().includes(rule)) {
    su({ step_index: i, state: 'DONE', step_type: 'tool', tool_name: name, duration_seconds: 0.01, tool_info: { name, parameters: params } })
    return true
  }
  su({ step_index: i, state: 'ERROR', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params, error: { type: 'TOOL_ERROR', message: `permission check failed for ${rule.split('(')[0]}: user denied permission for ${rule}\nDo not attempt to circumvent this denial` } } })
  return false
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.event !== 'user') return
  const content = typeof m.message.content === 'string' ? m.message.content : m.message.content.map((c) => c.text).join('')
  turnN++
  const denied = []
  su({ step_index: step++, state: 'DONE', step_type: 'user_input' })
  const cancelled = new Promise((res) => { running = () => res('cancel') })
  const usage = { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 165 }
  const finish = (status = 'SUCCESS', extra = {}) => { running = null; out({ event: 'result', result: { conversation_id: convo, status, response: '', num_turns: 1, usage, ...extra } }) }
  if (content.includes('flags')) { text(`args=${argv.join(' ')}`); return finish() }
  if (content.includes('slow')) {
    su({ step_index: step++, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 30' } } })
    await Promise.race([cancelled, new Promise((r) => setTimeout(r, 30000))])
    return finish()
  }
  const retry = content.includes('Please retry')
  const actions = retry ? lastActions : []
  if (!retry && content.includes('write')) actions.push({ kind: 'write', target: realish(/write (\S+)/.exec(content)?.[1] ?? 'a.txt') })
  if (!retry && content.includes('run')) actions.push({ kind: 'run', cmd: /run `([^`]+)`/.exec(content)?.[1] ?? 'echo hi' })
  const failed = []
  for (const a of actions) {
    if (a.kind === 'write') { if (!(await tool('write_to_file', { TargetFile: a.target }, `write_file(${a.target})`))) { denied.push({ action: 'write_file', display_name: 'WriteToFile' }); failed.push(a) } }
    else if (!(await tool('run_command', { CommandLine: a.cmd }, `command(${a.cmd})`))) { denied.push({ action: 'command', display_name: 'RunCommand' }); failed.push(a) }
  }
  lastActions = failed
  if (statePath) { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(failed)) }
  text(denied.length ? 'blocked' : `done ${turnN}`)
  finish('SUCCESS', denied.length ? { denied_actions: denied } : {})
})
