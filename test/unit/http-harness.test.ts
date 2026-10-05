import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { fillTemplate, getPath, parseManifest, type HttpManifest } from '../../src/harness/http/manifest'
import { HttpSession } from '../../src/harness/http/session'
import { httpFactory } from '../../src/harness/http/factory'
import type { AgentEvent } from '../../src/shared/events'
import { collect, friendFor } from './helpers'

let server: Server
let base: string
let seen: { url: string; auth?: string; body: unknown }[]
const readBody = (req: IncomingMessage) => new Promise<unknown>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : null)) })

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req)
    seen.push({ url: req.url ?? '', auth: req.headers.authorization, body })
    if (req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const d of [{ conversation: 'conv-1', delta: 'Hel' }, { delta: 'lo ' }, { delta: 'world' }]) { res.write(`data: ${JSON.stringify(d)}\n\n`); await new Promise((r) => setTimeout(r, 10)) }
      res.write(`data: ${JSON.stringify({ finish: 'stop' })}\n\n`)
      return void res.end('data: [DONE]\n\n')
    }
    if (req.url === '/ndjson') { res.writeHead(200); res.write('{"t":"a"}\n{"t":"b"}\n'); return void res.end('{"t":"c","end":true}\n') }
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ choices: [{ message: { content: 'whole reply' } }], id: 'c9' })) }
    if (req.url === '/slow') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"delta":"start"}\n\n'); return void setTimeout(() => res.end(), 5000) }
    if (req.url === '/err') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return void res.end('data: {"error":{"message":"quota exceeded"}}\n\n') }
    if (req.url === '/boom') { res.writeHead(503); return void res.end('upstream down') }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => { seen = [] })

const manifest = (over: Partial<HttpManifest> = {}): HttpManifest => ({
  baseUrl: base, send: { path: '/sse', body: { message: '{{text}}', conversation_id: '{{session}}' } }, stream: 'sse',
  map: { text: 'delta', done: { path: 'finish', equals: 'stop' }, session: 'conversation' }, ...over
})
const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

test('template and path helpers', () => {
  expect(getPath({ a: [{ b: 5 }] }, 'a.0.b')).toBe(5)
  expect(getPath({ a: null }, 'a.b')).toBeUndefined()
  expect(fillTemplate({ m: 'say {{text}}', c: '{{session}}', n: { keep: 1 } }, { text: 'hi', session: null })).toEqual({ m: 'say hi', n: { keep: 1 } }) // no session yet: key dropped
  expect(fillTemplate({ c: '{{session}}', arr: ['{{text}}'] }, { text: 'x', session: 's1' })).toEqual({ c: 's1', arr: ['x'] })
})

test('streams SSE text, remembers the conversation id for the next message, sends the bearer token', async () => {
  const s = new HttpSession({ manifest: manifest(), token: 'tok-1' })
  const c = collect(s)
  s.send({ text: 'hello' })
  expect(await c.turnEnd()).toMatchObject({ reason: 'done' })
  expect(text(c.events)).toBe('Hello world')
  expect(seen[0]).toMatchObject({ auth: 'Bearer tok-1', body: { message: 'hello' } })
  expect(seen[0]!.body).not.toHaveProperty('conversation_id')
  expect(s.resumeId).toBe('conv-1')
  const c2 = collect(s)
  s.send({ text: 'again' })
  await c2.turnEnd()
  expect(seen[1]!.body).toMatchObject({ message: 'again', conversation_id: 'conv-1' })
})

test('ndjson and single-JSON replies work, and a done marker ends the read early', async () => {
  const nd = new HttpSession({ manifest: manifest({ send: { path: '/ndjson', body: { m: '{{text}}' } }, stream: 'ndjson', map: { text: 't', done: { path: 'end' } } }), token: null })
  const c = collect(nd)
  nd.send({ text: 'x' })
  await c.turnEnd()
  expect(text(c.events)).toBe('abc')
  const js = new HttpSession({ manifest: manifest({ send: { path: '/json', body: { m: '{{text}}' } }, stream: 'json', map: { text: 'choices.0.message.content', session: 'id' } }), token: null })
  const c2 = collect(js)
  js.send({ text: 'x' })
  await c2.turnEnd()
  expect(text(c2.events)).toBe('whole reply')
  expect(js.resumeId).toBe('c9')
  expect(seen.some((r) => r.auth)).toBe(false) // no token configured: no Authorization header
})

test('errors: HTTP failures and in-stream error fields end the turn once', async () => {
  const bad = new HttpSession({ manifest: manifest({ send: { path: '/boom', body: {} } }), token: null })
  const c = collect(bad)
  bad.send({ text: 'x' })
  expect(await c.turnEnd()).toMatchObject({ reason: 'error', error: expect.stringContaining('503: upstream down') })
  const q = new HttpSession({ manifest: manifest({ send: { path: '/err', body: {} }, map: { text: 'delta', error: 'error.message' } }), token: null })
  const c2 = collect(q)
  q.send({ text: 'x' })
  await c2.turnEnd()
  await new Promise((r) => setTimeout(r, 50))
  expect(c2.events.filter((e) => e.t === 'turn_end')).toEqual([{ t: 'turn_end', reason: 'error', error: 'quota exceeded' }])
})

test('Nudge drops the connection quickly and calls the cancel endpoint when the manifest has one', async () => {
  const s = new HttpSession({ manifest: manifest({ send: { path: '/slow', body: {} }, cancel: { path: '/cancel/{{session}}' } }), token: 'k' })
  const c = collect(s)
  s.send({ text: 'x' })
  await c.until((e) => e.t === 'text')
  const t0 = Date.now()
  await s.interrupt()
  expect(await c.turnEnd()).toMatchObject({ reason: 'interrupted' })
  expect(Date.now() - t0).toBeLessThan(1000)
  await new Promise((r) => setTimeout(r, 100))
  expect(seen.some((r) => r.url.startsWith('/cancel/') && r.auth === 'Bearer k')).toBe(true)
})

test('manifests are validated: https only (localhost may use http), paths, stream and text mapping', () => {
  const good = JSON.stringify(manifest())
  expect(parseManifest(good).stream).toBe('sse')
  const bad = (m: unknown, re: RegExp) => expect(() => parseManifest(JSON.stringify(m))).toThrow(re)
  bad({ ...manifest(), baseUrl: 'http://evil.example.com' }, /https/)
  bad({ ...manifest(), baseUrl: 'nope' }, /full URL/)
  bad({ ...manifest(), send: { path: 'chat', body: {} } }, /start with/)
  bad({ ...manifest(), stream: 'websocket' }, /stream/)
  bad({ ...manifest(), map: {} }, /map\.text/)
  expect(() => parseManifest('{not json')).toThrow(/valid JSON/)
})

test('the factory reads the token from the keychain and refuses when it is missing', async () => {
  const f = friendFor({ harness: 'http', displayName: 'Remote', args: [JSON.stringify(manifest({ auth: { type: 'bearer', secret: 'remote' } }))] }) as never
  const ok = await httpFactory({ get: async () => 'secret-token' })({ friend: f, chatId: 'c', cwd: '/', mode: 'ask' })
  expect(ok).toBeInstanceOf(HttpSession)
  await expect(httpFactory({ get: async () => null })({ friend: f, chatId: 'c', cwd: '/', mode: 'ask' })).rejects.toThrow(/no token stored for Remote/)
})
