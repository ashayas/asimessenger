import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { ClaudeSession } from '../../src/harness/claude/session'
import { CodexSession } from '../../src/harness/codex/session'
import { EchoAgent } from '../../src/harness/echo-agent'
import { loadImages } from '../../src/harness/images'
import { HarnessManager } from '../../src/harness/manager'
import { PiSession } from '../../src/harness/pi/session'
import { createChatService } from '../../src/main/chat-service'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { createIngestor } from '../../src/main/ingest'
import { imageMime, imagePrompt, kindForFile, safeImageName } from '../../src/shared/attachments'
import type { AgentEvent, AgentSession, UserTurn } from '../../src/shared/events'
import { collect, friendFor } from './helpers'

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
let tmp: string
let imgPath: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'asi-img-')); imgPath = join(tmp, 'shot.png'); writeFileSync(imgPath, PNG) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const turn = (): UserTurn => ({ text: 'look', images: [{ path: imgPath, mimeType: 'image/png', name: 'shot.png' }] })
const text = (ev: AgentEvent[]) => ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

describe('picture helpers', () => {
  test('mime, kind and safe names', () => {
    expect(imageMime('A.PNG')).toBe('image/png')
    expect(imageMime('x.jpeg')).toBe('image/jpeg')
    expect(imageMime('notes.txt')).toBeNull()
    expect(kindForFile('x.webp')).toBe('image')
    expect(safeImageName('My Screenshot (1).png', 5)).toBe('My-Screenshot-1-5.png')
    expect(safeImageName('../../etc/passwd', 5)).toBe('passwd-5.png') // no traversal, unknown extension becomes png
    expect(imagePrompt('a.png', '/w/.attachments/a.png', 'what is this?')).toContain('/w/.attachments/a.png')
  })

  test('loadImages reads base64 and skips missing files', () => {
    const out = loadImages({ text: '', images: [{ path: imgPath, mimeType: 'image/png', name: 'a' }, { path: join(tmp, 'gone.png'), mimeType: 'image/png', name: 'b' }] })
    expect(out).toHaveLength(1)
    expect(Buffer.from(out[0]!.data, 'base64').equals(PNG)).toBe(true)
  })
})

describe('adapters pass pictures natively', () => {
  let s: AgentSession | null = null
  afterEach(async () => { await s?.dispose(); s = null })

  test('claude: image content block', async () => {
    s = new ClaudeSession({ command: process.execPath, env: process.env, cwd: process.cwd(), mode: 'ask', dangerousAllowed: false, prefixArgs: [resolve('test/fixtures/mock-claude.mjs')] })
    const c = collect(s); s.send(turn()); await c.turnEnd()
    expect(text(c.events)).toContain('[img:1]')
  })

  test('pi: images on the prompt command', async () => {
    s = new PiSession({ command: process.execPath, prefixArgs: [resolve('test/fixtures/mock-pi.mjs')], env: process.env, cwd: process.cwd(), mode: 'ask', dangerousAllowed: false, sessionFile: join(tmp, 's.jsonl'), extensionPath: '/x.js' })
    const c = collect(s); s.send(turn()); await c.turnEnd()
    expect(text(c.events)).toContain('[img:1]')
  })

  test('codex: localImage input', async () => {
    s = await CodexSession.create({ command: process.execPath, prefixArgs: [resolve('test/fixtures/mock-codex.mjs')], env: process.env, cwd: process.cwd(), mode: 'ask' })
    const c = collect(s); s.send(turn()); await c.turnEnd()
    expect(text(c.events)).toContain('[img:1]')
  })

  test('acp: image block only when the agent advertises it', async () => {
    const mock = resolve('test/fixtures/mock-acp-agent.mjs')
    s = await acpFactory({ command: process.execPath, args: [mock] })({ friend: friendFor() as never, chatId: 'c', cwd: process.cwd(), mode: 'ask' })
    const c = collect(s); s.send(turn()); await c.turnEnd()
    expect(text(c.events)).toContain('[img:1]')
    await s.dispose()
    s = await acpFactory({ command: process.execPath, args: [mock, '--no-images'] })({ friend: friendFor() as never, chatId: 'c', cwd: process.cwd(), mode: 'ask' })
    const c2 = collect(s); s.send(turn()); await c2.turnEnd()
    expect(text(c2.events)).not.toContain('[img:')
  })
})

describe('chat service: saving and sending pictures', () => {
  let db: Db
  let repo: Repo
  let manager: HarnessManager
  let service: ReturnType<typeof createChatService>
  let chatId: string
  let ws: string
  const turns: UserTurn[] = []
  beforeEach(async () => {
    turns.length = 0
    ws = join(tmp, 'ws'); (await import('node:fs')).mkdirSync(ws)
    db = await openDb(':memory:')
    repo = createRepo(db)
    const ingestor = createIngestor(repo, () => {})
    manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
    manager.register('echo', async () => { const a = new EchoAgent(); const send = a.send.bind(a); a.send = (t: UserTurn) => { turns.push(t); send(t) }; return a })
    service = createChatService({ repo, manager, ingestor, notify: () => {} })
    const w = await repo.workspaces.create({ name: 'w', path: ws })
    const f = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
    chatId = (await repo.chats.create({ workspaceId: w.id, friendId: f.id })).id
  })
  afterEach(async () => { await manager.disposeAll(); db.close() })

  test('a pasted picture is saved under .attachments in the workspace', async () => {
    const p = await service.saveImage(chatId, 'image.png', PNG)
    expect(p.startsWith(join(ws, '.attachments'))).toBe(true)
    expect(readFileSync(p).equals(PNG)).toBe(true)
  })

  test('refuses non-pictures and oversized pictures', async () => {
    await expect(service.saveImage(chatId, 'run.sh', PNG)).rejects.toThrow(/png, jpg, gif and webp/)
    await expect(service.saveImage(chatId, 'big.png', new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MB/)
  })

  test('sending a picture from outside the workspace copies it in, shows it, and hands the agent the pixels and the path', async () => {
    await service.sendFiles(chatId, [imgPath], 'what is this?')
    const att = (await repo.messages.list(chatId)).find((m) => m.kind === 'attachment')!
    const body = att.body as { kind: string; path: string }
    expect(body.kind).toBe('image')
    expect(body.path.startsWith(join(ws, '.attachments'))).toBe(true)
    expect(existsSync(body.path)).toBe(true)
    expect(turns[0]!.images).toEqual([{ path: body.path, mimeType: 'image/png', name: expect.stringMatching(/^shot-\d+\.png$/) }])
    expect(turns[0]!.text).toContain('what is this?')
    expect((await repo.messages.list(chatId)).some((m) => m.role === 'user' && m.kind === 'text' && m.text === 'what is this?')).toBe(true)
    expect(turns[0]!.text).toContain(body.path)
  })

  test('a picture already inside the workspace is used in place', async () => {
    const inside = join(ws, 'a.png'); writeFileSync(inside, PNG)
    await service.sendFiles(chatId, [inside])
    expect(turns[0]!.images![0]!.path).toBe(inside)
  })
})
