import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface DiscoveredSession {
  harness: 'claude' | 'codex'
  sessionId: string
  cwd: string
  title: string
  lastActive: number
}

/** Read at most the first `bytes` of a file, as lines. Session files can be hundreds of MB. */
async function head(file: string, bytes = 256 * 1024): Promise<string[]> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1)
  } finally {
    await fh.close()
  }
}

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 70)

async function claudeSessions(home: string, since: number): Promise<DiscoveredSession[]> {
  const root = join(home, '.claude', 'projects')
  const out: DiscoveredSession[] = []
  const dirs = await readdir(root).catch(() => null)
  if (!dirs) return out
  for (const d of dirs) {
    const files = await readdir(join(root, d)).catch(() => null)
    if (!files) continue
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue // subagent transcripts live in subdirectories
      const path = join(root, d, f)
      const st = await stat(path).catch(() => null)
      if (!st || st.mtimeMs < since) continue
      let cwd = ''
      let title = ''
      for (const line of await head(path).catch(() => [])) {
        try {
          const j = JSON.parse(line) as { type?: string; cwd?: string; message?: { content?: unknown } }
          if (!cwd && j.cwd) cwd = j.cwd
          if (!title && j.type === 'user') {
            const c = j.message?.content
            const t = typeof c === 'string' ? c : Array.isArray(c) ? ((c as { type?: string; text?: string }[]).find((b) => b.type === 'text')?.text ?? '') : ''
            if (t && !t.startsWith('<')) title = clip(t)
          }
        } catch { /* partial last line */ }
        if (cwd && title) break
      }
      if (cwd) out.push({ harness: 'claude', sessionId: f.replace(/\.jsonl$/, ''), cwd, title: title || 'Claude Code session', lastActive: st.mtimeMs })
    }
  }
  return out
}

async function codexSessions(home: string, since: number): Promise<DiscoveredSession[]> {
  const root = join(home, '.codex', 'sessions')
  const out: DiscoveredSession[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir).catch(() => null)
    if (!entries) return
    for (const e of entries) {
      const p = join(dir, e)
      if (depth < 3) { await walk(p, depth + 1); continue }
      if (!e.endsWith('.jsonl')) continue
      const st = await stat(p).catch(() => null)
      if (!st || st.mtimeMs < since) continue
      let id = ''
      let cwd = ''
      let title = ''
      for (const line of await head(p, 128 * 1024).catch(() => [])) {
        try {
          const j = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string; type?: string; message?: string } }
          if (j.type === 'session_meta') { id = j.payload?.id ?? ''; cwd = j.payload?.cwd ?? '' }
          if (!title && j.payload?.type === 'user_message' && j.payload.message) title = clip(j.payload.message)
        } catch { /* partial */ }
        if (id && title) break
      }
      if (id && cwd) out.push({ harness: 'codex', sessionId: id, cwd, title: title || 'Codex session', lastActive: st.mtimeMs })
    }
  }
  await walk(root, 0)
  return out
}

/** Sessions recently written by Claude Code or Codex on this machine, newest first. */
export async function discoverSessions(opts: { home: string; now?: number; windowMs?: number }): Promise<DiscoveredSession[]> {
  const since = (opts.now ?? Date.now()) - (opts.windowMs ?? 15 * 60_000)
  const [a, b] = await Promise.all([claudeSessions(opts.home, since), codexSessions(opts.home, since)])
  return [...a, ...b].sort((x, y) => y.lastActive - x.lastActive)
}
