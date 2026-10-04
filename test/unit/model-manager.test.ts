import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createModelManager, type Progress } from '../../src/main/model-manager'
import { neededBytes, type VoiceModel } from '../../src/shared/voice-models'

let work: string
let server: Server
let base: string
let archive: Buffer
let rangeHeaders: (string | undefined)[]
let slow = false
let model: VoiceModel

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'asi-mm-'))
  const src = join(work, 'src', 'tiny-model')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'model.safetensors'), Buffer.alloc(300_000, 7))
  writeFileSync(join(src, 'LICENSE'), 'Apache-2.0')
  execFileSync('tar', ['-C', join(work, 'src'), '-cf', join(work, 'tiny-model.tar'), 'tiny-model'])
  archive = readFileSync(join(work, 'tiny-model.tar'))
  server = createServer((req, res) => {
    if (req.url === '/missing.tar') { res.writeHead(404); return void res.end() }
    rangeHeaders.push(req.headers.range)
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    const body = archive.subarray(start)
    res.writeHead(m ? 206 : 200, { 'Content-Length': body.length, ...(m ? { 'Content-Range': `bytes ${start}-${archive.length - 1}/${archive.length}` } : {}) })
    if (!slow) return void res.end(body)
    res.write(body.subarray(0, 1000))
    setTimeout(() => res.end(body.subarray(1000)), 3000)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close(); rmSync(work, { recursive: true, force: true }) })

let root: string
beforeEach(() => {
  rangeHeaders = []
  slow = false
  root = mkdtempSync(join(work, 'root-'))
  model = { id: 'tiny', name: 'Tiny', blurb: '', archive: 'tiny-model.tar', bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), urls: [`${base}/tiny-model.tar`] }
})
const mgr = (over = {}) => createModelManager({ root, freeBytes: async () => 1e12, ...over })

test('downloads, verifies, extracts and marks the model installed, reporting progress', async () => {
  const phases: Progress['phase'][] = []
  const st = await mgr().install(model, (p) => { if (phases.at(-1) !== p.phase) phases.push(p.phase) })
  expect(phases).toEqual(['checking', 'downloading', 'verifying', 'extracting', 'done'])
  expect(st).toMatchObject({ installed: true, partialBytes: 0 })
  expect(readFileSync(join(st.path!, 'LICENSE'), 'utf8')).toBe('Apache-2.0')
  expect(existsSync(join(root, 'downloads', 'tiny-model.tar.part'))).toBe(false) // archive removed after extraction
  expect(await mgr().installedSha(model)).toBe(model.sha256)
})

test('resumes a partial download with a Range request instead of starting over', async () => {
  mkdirSync(join(root, 'downloads'), { recursive: true })
  writeFileSync(join(root, 'downloads', 'tiny-model.tar.part'), archive.subarray(0, 100_000))
  const m = mgr()
  expect((await m.status(model)).partialBytes).toBe(100_000)
  await m.install(model)
  expect(rangeHeaders).toEqual(['bytes=100000-'])
  expect((await m.status(model)).installed).toBe(true)
})

test('a corrupt archive is rejected and deleted, never installed', async () => {
  const bad = { ...model, sha256: '0'.repeat(64) }
  const m = mgr()
  await expect(m.install(bad)).rejects.toThrow(/corrupt/)
  expect(existsSync(join(root, 'downloads', 'tiny-model.tar.part'))).toBe(false)
  expect((await m.status(bad)).installed).toBe(false)
})

test('not enough disk space blocks the download before anything is fetched', async () => {
  const m = mgr({ freeBytes: async () => 1000 })
  await expect(m.install(model)).rejects.toThrow(/not enough disk space/)
  expect(rangeHeaders).toEqual([])
  expect(neededBytes(model, true)).toBeGreaterThan(neededBytes(model, false))
})

test('falls back to the next URL when the first fails', async () => {
  const withFallback = { ...model, urls: [`${base}/missing.tar`, `${base}/tiny-model.tar`] }
  expect((await mgr().install(withFallback)).installed).toBe(true)
  await expect(mgr().install({ ...model, urls: [`${base}/missing.tar`] })).rejects.toThrow(/could not download Tiny: .* 404/)
})

test('cancel stops an in-flight download; remove deletes the model', async () => {
  slow = true
  const m = mgr()
  const p = m.install(model)
  await new Promise((r) => setTimeout(r, 400))
  expect(m.isInstalling(model)).toBe(true)
  await expect(m.install(model)).rejects.toThrow(/already downloading/)
  m.cancel(model)
  await expect(p).rejects.toThrow(/cancelled/)
  expect(m.isInstalling(model)).toBe(false)

  slow = false
  await m.install(model)
  await m.remove(model)
  expect((await m.status(model)).installed).toBe(false)
})
