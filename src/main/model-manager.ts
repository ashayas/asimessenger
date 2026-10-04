import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { neededBytes, type VoiceModel } from '@shared/voice-models'

export interface Progress {
  phase: 'checking' | 'downloading' | 'verifying' | 'extracting' | 'done'
  received: number
  total: number
}

export interface ModelStatus {
  id: string
  installed: boolean
  partialBytes: number
  path: string | null
}

export interface ManagerOptions {
  /** Where models live, e.g. <userData>/voice. */
  root: string
  /** Free bytes on that volume; injectable for tests. */
  freeBytes?: (dir: string) => Promise<number>
  /** Whether the Python runtime will also be installed (counts toward the disk check). */
  runtimeNeeded?: () => boolean
  fetchImpl?: typeof fetch
}

const defaultFree = async (dir: string) => { const s = await statfs(dir); return s.bavail * s.bsize }

export function createModelManager(opts: ManagerOptions) {
  const dir = (m: VoiceModel) => join(opts.root, 'models', m.id)
  const marker = (m: VoiceModel) => join(dir(m), '.installed')
  const part = (m: VoiceModel) => join(opts.root, 'downloads', `${m.archive}.part`)
  const doFetch = opts.fetchImpl ?? fetch
  const running = new Map<string, AbortController>()

  async function sha256(file: string): Promise<string> {
    const h = createHash('sha256')
    await pipeline(createReadStream(file), h)
    return h.digest('hex')
  }

  async function download(url: string, dest: string, total: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
    let have = existsSync(dest) ? statSync(dest).size : 0
    if (have > total) { await rm(dest, { force: true }); have = 0 }
    if (have === total) return
    const res = await doFetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' })
    if (res.status === 416) { await rm(dest, { force: true }); throw new Error('the partial download was out of range; retry') }
    if (!res.ok || !res.body) throw new Error(`${new URL(url).host} answered ${res.status}`)
    const resumed = res.status === 206
    if (!resumed && have) { await rm(dest, { force: true }); have = 0 }
    onBytes(have)
    const out = createWriteStream(dest, { flags: resumed ? 'a' : 'w' })
    let n = have
    const body = Readable.fromWeb(res.body as never)
    body.on('data', (c: Buffer) => { n += c.length; onBytes(n) })
    await pipeline(body, out)
  }

  const untar = (archive: string, into: string) =>
    new Promise<void>((resolve, reject) => execFile('tar', ['-xf', archive, '-C', into], (e) => (e ? reject(e) : resolve())))

  return {
    async status(m: VoiceModel): Promise<ModelStatus> {
      const installed = existsSync(marker(m))
      return { id: m.id, installed, partialBytes: existsSync(part(m)) ? statSync(part(m)).size : 0, path: installed ? join(dir(m), m.archive.replace(/\.tar$/, '')) : null }
    },

    isInstalling: (m: VoiceModel) => running.has(m.id),

    cancel(m: VoiceModel): void { running.get(m.id)?.abort() },

    /** Download, verify, extract. Resumes a partial download; tries each URL in order. */
    async install(m: VoiceModel, onProgress: (p: Progress) => void = () => {}): Promise<ModelStatus> {
      if (running.has(m.id)) throw new Error('already downloading')
      const ac = new AbortController()
      running.set(m.id, ac)
      try {
        await mkdir(join(opts.root, 'downloads'), { recursive: true })
        await mkdir(join(opts.root, 'models'), { recursive: true })
        onProgress({ phase: 'checking', received: 0, total: m.bytes })
        const free = await (opts.freeBytes ?? defaultFree)(opts.root)
        const need = neededBytes(m, opts.runtimeNeeded?.() ?? false)
        if (free < need) throw new Error(`not enough disk space: ${(need / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free`)

        let lastErr: unknown = null
        let ok = false
        for (const url of m.urls) {
          try {
            await download(url, part(m), m.bytes, ac.signal, (received) => onProgress({ phase: 'downloading', received, total: m.bytes }))
            ok = true
            break
          } catch (e) {
            if (ac.signal.aborted) throw new Error('download cancelled')
            lastErr = e
          }
        }
        if (!ok) throw new Error(`could not download ${m.name}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)

        onProgress({ phase: 'verifying', received: m.bytes, total: m.bytes })
        if (statSync(part(m)).size !== m.bytes || (await sha256(part(m))) !== m.sha256) {
          await rm(part(m), { force: true }) // never keep a corrupt archive around
          throw new Error('the download is corrupt (checksum mismatch); it was deleted, please try again')
        }
        onProgress({ phase: 'extracting', received: m.bytes, total: m.bytes })
        const tmp = join(opts.root, 'models', `${m.id}.tmp`)
        await rm(tmp, { recursive: true, force: true })
        await mkdir(tmp, { recursive: true })
        await untar(part(m), tmp)
        await rm(dir(m), { recursive: true, force: true })
        await rename(tmp, dir(m))
        await writeFile(marker(m), JSON.stringify({ sha256: m.sha256, installedAt: Date.now() }))
        await rm(part(m), { force: true })
        onProgress({ phase: 'done', received: m.bytes, total: m.bytes })
        return this.status(m)
      } finally {
        running.delete(m.id)
      }
    },

    async remove(m: VoiceModel): Promise<void> {
      await rm(dir(m), { recursive: true, force: true })
      await rm(part(m), { force: true })
    },

    async installedSha(m: VoiceModel): Promise<string | null> {
      try { return (JSON.parse(await readFile(marker(m), 'utf8')) as { sha256: string }).sha256 } catch { return null }
    }
  }
}

export type ModelManager = ReturnType<typeof createModelManager>
