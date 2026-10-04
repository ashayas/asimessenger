import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDb, type Db } from '../../src/main/db/db'
import { createRepo, type Repo } from '../../src/main/db/repo'
import { listDrawings, loadDrawing, newDrawingName, safeName, saveDrawing, savePng } from '../../src/main/doodle'
import { searchAll } from '../../src/main/search'

let dir: string
let db: Db
let repo: Repo
let wsId: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'asi-dd-'))
  db = await openDb(':memory:')
  repo = createRepo(db)
  wsId = (await repo.workspaces.create({ name: 'w', path: dir })).id
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); db.close() })

test('names are validated against path tricks', () => {
  expect(safeName('auth flow.v2')).toBe('auth flow.v2')
  for (const bad of ['../x', 'a/b', '', '.hidden', 'a\\b', 'x'.repeat(200)]) expect(() => safeName(bad)).toThrow()
})

test('save writes under .drawings, indexes the file and round-trips', async () => {
  expect(await loadDrawing(repo, wsId, 'nope')).toBeNull()
  const path = await saveDrawing(repo, wsId, 'auth-flow', '{"elements":[]}')
  expect(path).toBe(join(dir, '.drawings', 'auth-flow.excalidraw'))
  expect(readFileSync(path, 'utf8')).toBe('{"elements":[]}')
  expect(await loadDrawing(repo, wsId, 'auth-flow')).toBe('{"elements":[]}')
  expect((await listDrawings(repo, wsId)).map((d) => d.name)).toEqual(['auth-flow'])
  const hit = (await searchAll(repo, 'auth-flow'))[0]!
  expect(hit).toMatchObject({ kind: 'drawing', target: { type: 'drawing', workspaceId: wsId, name: 'auth-flow' } })
  await expect(saveDrawing(repo, wsId, 'bad', 'not json')).rejects.toThrow()
  expect(existsSync(join(dir, '.drawings', 'bad.excalidraw'))).toBe(false)
})

test('new drawing names count up per day', async () => {
  const day = new Date('2026-10-04T12:00:00Z')
  expect(await newDrawingName(repo, wsId, day)).toBe('drawing-2026-10-04-1')
  await saveDrawing(repo, wsId, 'drawing-2026-10-04-1', '{}')
  expect(await newDrawingName(repo, wsId, day)).toBe('drawing-2026-10-04-2')
})

test('png export is stored next to the source', async () => {
  const p = await savePng(repo, wsId, 'diagram', Buffer.from('PNGDATA').toString('base64'))
  expect(p).toBe(join(dir, '.drawings', 'diagram.png'))
  expect(readFileSync(p, 'utf8')).toBe('PNGDATA')
})
