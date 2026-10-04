import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loginEnv, which } from '../harness/env'

const UV_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz'

export interface RuntimeOptions {
  root: string
  requirementsPath: string
  /** Override for tests. */
  uvPath?: string
  fetchImpl?: typeof fetch
}

/** The Python environment that runs MLX models. Created with uv (used if present, else downloaded) in app support. */
export function createVoiceRuntime(o: RuntimeOptions) {
  const venv = join(o.root, 'venv')
  const python = join(venv, 'bin', 'python')
  const marker = join(venv, '.asi-runtime')
  const reqHash = async () => createHash('sha256').update(await readFile(o.requirementsPath)).digest('hex')

  async function ensureUv(log: (l: string) => void): Promise<string> {
    if (o.uvPath) return o.uvPath
    const found = which('uv', await loginEnv())
    if (found) return found
    const bin = join(o.root, 'bin')
    const uv = join(bin, 'uv')
    if (existsSync(uv)) return uv
    log('Downloading the uv Python manager…')
    await mkdir(bin, { recursive: true })
    const res = await (o.fetchImpl ?? fetch)(UV_URL, { redirect: 'follow' })
    if (!res.ok) throw new Error(`could not download uv (${res.status})`)
    const tgz = join(bin, 'uv.tar.gz')
    await writeFile(tgz, Buffer.from(await res.arrayBuffer()))
    await new Promise<void>((resolve, reject) => execFile('tar', ['-xzf', tgz, '-C', bin, '--strip-components=1'], (e) => (e ? reject(e) : resolve())))
    await rm(tgz, { force: true })
    await chmod(uv, 0o755)
    return uv
  }

  const run = (cmd: string, args: string[], log: (l: string) => void) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let tail = ''
      const onData = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) { log(l.trim()); tail = l.trim() } }
      p.stdout.on('data', onData)
      p.stderr.on('data', onData)
      p.on('error', reject)
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd.split('/').pop()} failed (${c}): ${tail}`))))
    })

  return {
    pythonPath: python,
    async status(): Promise<{ installed: boolean }> {
      try { return { installed: existsSync(python) && (await readFile(marker, 'utf8')) === (await reqHash()) } } catch { return { installed: false } }
    },
    async install(log: (l: string) => void = () => {}): Promise<void> {
      const uv = await ensureUv(log)
      await mkdir(o.root, { recursive: true })
      if (!existsSync(python)) { log('Creating the Python 3.12 environment…'); await run(uv, ['venv', '--python', '3.12', venv], log) }
      log('Installing MLX and mlx-audio (about 350 MB)…')
      await run(uv, ['pip', 'install', '--python', python, '-r', o.requirementsPath], log)
      await writeFile(marker, await reqHash())
    },
    async remove(): Promise<void> { await rm(venv, { recursive: true, force: true }) }
  }
}

export type VoiceRuntime = ReturnType<typeof createVoiceRuntime>
