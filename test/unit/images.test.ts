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
import { fileBadge, fmtBytes, imageMime, imagePrompt, kindForFile, safeFileName, safeImageName } from '../../src/shared/attachments'
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

describe('any other file: kept on disk, opened with the default app, no size cap in memory', () => {
  let db: Db
  let repo: Repo
  let manager: HarnessManager
  let service: ReturnType<typeof createChatService>
  let chatId: string
  let ws: string
  const turns: UserTurn[] = []
  const opened: { mode: string; path: string }[] = []
  beforeEach(async () => {
    turns.length = 0; opened.length = 0
    ws = join(tmp, 'ws2'); (await import('node:fs')).mkdirSync(ws)
    db = await openDb(':memory:')
    repo = createRepo(db)
    const ingestor = createIngestor(repo, () => {})
    manager = new HarnessManager({ onEvent: (id, e) => void ingestor.ingest(id, e) })
    manager.register('echo', async () => { const a = new EchoAgent(); const send = a.send.bind(a); a.send = (t: UserTurn) => { turns.push(t); send(t) }; return a })
    service = createChatService({ repo, manager, ingestor, notify: () => {}, opener: { url: () => {}, path: (p) => opened.push({ mode: 'open', path: p }), reveal: (p) => opened.push({ mode: 'reveal', path: p }) } })
    const w = await repo.workspaces.create({ name: 'w', path: ws })
    const f = await repo.friends.create({ harness: 'echo', displayName: 'Echo' })
    chatId = (await repo.chats.create({ workspaceId: w.id, friendId: f.id })).id
  })
  afterEach(async () => { await manager.disposeAll(); db.close() })

  const att = async () => (await repo.messages.list(chatId)).filter((m) => m.kind === 'attachment')

  test('kinds: small text the app can show stays inline; csv, spreadsheets, pdfs, archives and big text are plain files', () => {
    for (const n of ['notes.md', 'main.ts', 'x.patch', 'log.txt']) expect(kindForFile(n, 100)).not.toBe('file')
    for (const n of ['data.csv', 'book.xlsx', 'old.xls', 'report.pdf', 'dump.zip', 'noext', 'photo.heic']) expect(kindForFile(n, 100)).toBe('file')
    expect(kindForFile('huge.json', 5 * 1024 * 1024)).toBe('file')
    expect(kindForFile('pic.png', 5)).toBe('image')
    expect(fileBadge('Q3 numbers.XLSX')).toBe('XLSX')
    expect(fileBadge('Makefile')).toBe('FILE')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(23 * 1024 * 1024)).toBe('23 MB')
    expect(fmtBytes(1.2 * 1024 ** 3)).toBe('1.2 GB')
    expect(safeFileName('Q3 numbers (final).xlsx', 7)).toBe('Q3-numbers-final-7.xlsx')
    expect(safeFileName('Q3 numbers (final).xlsx')).toBe('Q3-numbers-final.xlsx')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
  })

  test('a csv is copied into .attachments, shown as a file card, and the agent is told where it is and how big', async () => {
    const csv = join(tmp, 'sales.csv'); writeFileSync(csv, 'region,amount\nnorth,10\nsouth,32\n')
    await service.sendFiles(chatId, [csv], 'sum the amount column')
    const [m] = await att()
    const b = m!.body as { kind: string; name: string; path: string; bytes: number }
    expect(b).toMatchObject({ kind: 'file', name: 'sales.csv', bytes: 32 })
    expect(b.path.endsWith('/sales.csv')).toBe(true) // it keeps its own name, in a folder of its own
    expect(b.path.startsWith(join(ws, '.attachments'))).toBe(true)
    expect(readFileSync(b.path, 'utf8')).toContain('south,32')
    expect(turns[0]!.text).toContain('sum the amount column')
    expect(turns[0]!.text).toContain(b.path)
    expect(turns[0]!.text).toContain('32 B')
    expect(turns[0]!.text).not.toContain('north,10') // not inlined: the agent opens the file
    expect(turns[0]!.images).toEqual([])
  })

  test('binary files (a spreadsheet, a zip) and big text go the same way, with no read into memory', async () => {
    const xls = join(tmp, 'book.xlsx'); writeFileSync(xls, Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0xff, 0xfe]))
    const big = join(tmp, 'big.log'); writeFileSync(big, 'line of text\n'.repeat(60_000)) // ~780 KB, over the inline limit
    const fake = join(tmp, 'secret.txt'); writeFileSync(fake, Buffer.from([0x68, 0x69, 0, 0, 1])) // "text" that is binary
    await service.sendFiles(chatId, [xls, big, fake])
    const rows = await att()
    expect(rows.map((r) => (r.body as { kind: string }).kind)).toEqual(['file', 'file', 'file'])
    expect(turns[0]!.text.match(/I'm attaching a file/g)).toHaveLength(3)
    expect(turns[0]!.text).not.toContain('line of text')
  })

  test('a file already inside the workspace is not copied; small code still opens in the viewer', async () => {
    const inside = join(ws, 'data.csv'); writeFileSync(inside, 'a,b\n1,2\n')
    const code = join(tmp, 'app.ts'); writeFileSync(code, 'export const x = 1\n')
    await service.sendFiles(chatId, [inside, code])
    const [file, snippet] = await att()
    expect((file!.body as { path: string }).path).toBe(inside)
    expect((snippet!.body as { kind: string; body: string })).toMatchObject({ kind: 'code', body: 'export const x = 1\n' })
    expect(turns[0]!.text).toContain('export const x = 1') // code is still inlined
  })

  test('a folder is refused with the way out, and a file over the cap is refused before anything is copied', async () => {
    const dir = join(tmp, 'folder'); (await import('node:fs')).mkdirSync(dir)
    await expect(service.sendFiles(chatId, [dir])).rejects.toThrow(/Zip it first/)
    expect(await att()).toHaveLength(0)
  })

  test('a pasted file (bytes only) is saved with its extension, and an oversized paste is refused', async () => {
    const p = await service.saveFile(chatId, 'Q3 report.pdf', new Uint8Array([37, 80, 68, 70]))
    expect(p.startsWith(join(ws, '.attachments'))).toBe(true)
    expect(p.endsWith('.pdf')).toBe(true)
    await expect(service.saveFile(chatId, 'x.bin', new Uint8Array(100 * 1024 * 1024 + 1))).rejects.toThrow(/100 MB/)
  })

  test('Open and Show in Finder reach the file, but only for files inside the chat’s workspace', async () => {
    const csv = join(tmp, 'sales.csv'); writeFileSync(csv, 'a\n1\n')
    await service.sendFiles(chatId, [csv])
    const [m] = await att()
    await service.openAttachmentFile(m!.id, 'open')
    await service.openAttachmentFile(m!.id, 'reveal')
    expect(opened.map((o) => o.mode)).toEqual(['open', 'reveal'])
    expect(opened[0]!.path).toBe((await import('node:fs')).realpathSync((m!.body as { path: string }).path))
    // a card that points outside the workspace (a doctored or agent-supplied path) is refused
    const evil = await repo.messages.append({ chatId, role: 'agent', kind: 'attachment', body: { t: 'attachment', id: 'x', kind: 'file', name: 'passwd', path: '/etc/passwd' }, text: 'passwd' })
    await expect(service.openAttachmentFile(evil.id, 'open')).rejects.toThrow(/outside this workspace/)
    expect(opened).toHaveLength(2)
  })

  test('loading a file card never reads the file, so a huge one cannot stall the viewer', async () => {
    const csv = join(tmp, 'sales.csv'); writeFileSync(csv, 'a\n1\n')
    await service.sendFiles(chatId, [csv])
    const [m] = await att()
    const { loadAttachment } = await import('../../src/main/attachments')
    expect(await loadAttachment(repo, m!.id)).toMatchObject({ kind: 'file', text: '', name: 'sales.csv' })
  })

  test('an agent can hand over a file by path; it must be inside the workspace', async () => {
    const out = join(ws, 'result.xlsx'); writeFileSync(out, Buffer.from([1, 2, 3, 4, 5]))
    expect(await service.resolveAgentFile(chatId, 'result.xlsx')).toEqual({ path: (await import('node:fs')).realpathSync(out), bytes: 5 })
    await expect(service.resolveAgentFile(chatId, '/etc/hosts')).rejects.toThrow(/outside this workspace/)
    await expect(service.resolveAgentFile(chatId, ws)).rejects.toThrow(/folder/)
  })
})
