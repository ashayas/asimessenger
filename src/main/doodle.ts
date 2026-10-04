import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Repo } from './db/repo'

const NAME_RE = /^[\w][\w .-]{0,80}$/

export interface DrawingInfo {
  name: string
  updatedAt: number
}

/** Drawings live next to the code they are about: <workspace>/.drawings/<name>.excalidraw */
export function safeName(name: string): string {
  const n = name.replace(/\.excalidraw$/, '').replace(/\.png$/, '')
  if (!NAME_RE.test(n) || n.includes('..')) throw new Error('invalid drawing name')
  return n
}

async function dirFor(repo: Repo, workspaceId: string): Promise<{ dir: string; workspaceId: string }> {
  const ws = await repo.workspaces.get(workspaceId)
  if (!ws) throw new Error('unknown workspace')
  const dir = join(ws.path, '.drawings')
  await mkdir(dir, { recursive: true })
  return { dir, workspaceId }
}

export async function listDrawings(repo: Repo, workspaceId: string): Promise<DrawingInfo[]> {
  const { dir } = await dirFor(repo, workspaceId)
  const out: DrawingInfo[] = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.excalidraw')) continue
    out.push({ name: f.replace(/\.excalidraw$/, ''), updatedAt: (await stat(join(dir, f))).mtimeMs })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function newDrawingName(repo: Repo, workspaceId: string, today = new Date()): Promise<string> {
  const existing = new Set((await listDrawings(repo, workspaceId)).map((d) => d.name))
  const day = today.toISOString().slice(0, 10)
  for (let i = 1; ; i++) {
    const name = `drawing-${day}-${i}`
    if (!existing.has(name)) return name
  }
}

export async function loadDrawing(repo: Repo, workspaceId: string, name: string): Promise<string | null> {
  const { dir } = await dirFor(repo, workspaceId)
  try { return await readFile(join(dir, `${safeName(name)}.excalidraw`), 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}

export async function saveDrawing(repo: Repo, workspaceId: string, name: string, json: string): Promise<string> {
  const { dir } = await dirFor(repo, workspaceId)
  JSON.parse(json) // refuse to write garbage
  const path = join(dir, `${safeName(name)}.excalidraw`)
  await writeFile(path, json, 'utf8')
  await repo.drawings.upsert({ workspaceId, path, title: `${safeName(name)}.excalidraw` })
  return path
}

export async function savePng(repo: Repo, workspaceId: string, name: string, base64: string): Promise<string> {
  const { dir } = await dirFor(repo, workspaceId)
  const path = join(dir, `${safeName(name)}.png`)
  await writeFile(path, Buffer.from(base64, 'base64'))
  return path
}
