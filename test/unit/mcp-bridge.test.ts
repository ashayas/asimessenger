import { afterEach, beforeEach, expect, test } from 'vitest'
import { createMcpBridge, isHttpUrl, type BridgeActions } from '../../src/main/mcp-bridge'

const calls: unknown[][] = []
const actions: BridgeActions = {
  chatExists: async (id) => id === 'chat-1',
  askUser: async (id, q, choices) => { calls.push(['ask', id, q, choices]); return 'Global' },
  sendAttachment: async (id, a) => { calls.push(['attach', id, a]) },
  openUrl: async (id, url) => { calls.push(['url', id, url]) },
  openDrawing: async (id, name) => { calls.push(['draw', id, name]) },
  setStatus: async (id, text) => { calls.push(['status', id, text]) }
}
let bridge: ReturnType<typeof createMcpBridge>
beforeEach(async () => { calls.length = 0; bridge = createMcpBridge(actions); await bridge.start() })
afterEach(() => bridge.stop())

const rpc = async (method: string, params?: unknown, over: { auth?: string | null; url?: string; host?: string } = {}) => {
  const ep = bridge.endpointFor('chat-1')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (over.auth !== null) headers['Authorization'] = over.auth ?? `Bearer ${ep.token}`
  if (over.host) headers['Host'] = over.host
  const res = await fetch(over.url ?? ep.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: res.status, body: res.status === 200 ? await res.json() : null }
}
const tool = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).body.result as { content: { text: string }[]; isError?: boolean }

test('handshake and tool listing', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'asi-messenger' } })
  const list = await rpc('tools/list')
  expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['ask_user', 'send_attachment', 'open_url', 'open_drawing', 'set_status'])
  expect((await rpc('nope')).body.error.code).toBe(-32601)
})

test('requests without the token, for unknown chats, or with a foreign Host are refused', async () => {
  expect((await rpc('tools/list', undefined, { auth: null })).status).toBe(401)
  expect((await rpc('tools/list', undefined, { auth: 'Bearer wrong' })).status).toBe(401)
  const ep = bridge.endpointFor('chat-1')
  expect((await rpc('tools/list', undefined, { url: ep.url.replace('chat-1', 'chat-9') })).status).toBe(404)
  expect((await rpc('tools/list', undefined, { url: ep.url.replace('/mcp/', '/other/') })).status).toBe(404)
})

test('ask_user waits for the answer and returns it', async () => {
  const r = await tool('ask_user', { question: 'Which lock?', choices: ['Per tab', 'Global'] })
  expect(r.content[0]!.text).toBe('Global')
  expect(calls[0]).toEqual(['ask', 'chat-1', 'Which lock?', ['Per tab', 'Global']])
  expect((await tool('ask_user', { question: '  ' })).isError).toBe(true)
})

test('send_attachment infers kind, validates input; open_url only allows http(s)', async () => {
  expect((await tool('send_attachment', { name: 'notes.md', content: '# hi' })).isError).toBeUndefined()
  expect(calls[0]).toMatchObject(['attach', 'chat-1', { name: 'notes.md', kind: 'markdown', content: '# hi' }])
  expect((await tool('send_attachment', { name: 'x.ts' })).isError).toBe(true)
  expect((await tool('open_url', { url: 'http://localhost:5173' })).isError).toBeUndefined()
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) expect((await tool('open_url', { url: bad })).isError).toBe(true)
  expect(calls.filter((c) => c[0] === 'url')).toHaveLength(1)
  expect(isHttpUrl('https://a.dev/x')).toBe(true)
})

test('open_drawing and set_status reach the app; notifications get 202', async () => {
  await tool('open_drawing', { name: 'auth-flow' })
  await tool('set_status', { text: 'x'.repeat(200) })
  expect(calls[0]).toEqual(['draw', 'chat-1', 'auth-flow'])
  expect((calls[1]![2] as string).length).toBe(80)
  const ep = bridge.endpointFor('chat-1')
  const res = await fetch(ep.url, { method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  expect(res.status).toBe(202)
})
