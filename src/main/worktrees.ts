import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { worktreeName } from '@shared/worktree-names'

export type GitRun = (args: string[], cwd: string) => Promise<string>

export interface Worktree {
  /** The directory the agent works in (the same sub-folder of the worktree as the workspace is of its repo). */
  path: string
  branch: string
}

export interface RemoveResult {
  /** The worktree folder is gone. */
  removed: boolean
  /** The branch is gone too. It is kept when it holds commits that are not merged anywhere else. */
  branchDeleted: boolean
  note: string | null
}

const defaultRun = (env: NodeJS.ProcessEnv): GitRun => (args, cwd) =>
  new Promise((res, rej) => execFile('git', args, { cwd, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim().split('\n')[0] ?? 'git failed')) : res(stdout))))

/** Git worktrees for isolated chats: one branch and one folder per chat, outside the repo so it stays clean. */
export function createWorktrees(o: { dir: string; env?: NodeJS.ProcessEnv; run?: GitRun }) {
  const git = o.run ?? defaultRun(o.env ?? process.env)
  const out = async (args: string[], cwd: string) => (await git(args, cwd)).trim()

  async function repoRoot(path: string): Promise<string> {
    try { return resolve(await out(['rev-parse', '--show-toplevel'], path)) } catch { throw new Error('this workspace is not a git repository') }
  }

  return {
    async isRepo(path: string): Promise<boolean> {
      try { await repoRoot(path); return true } catch { return false }
    },

    /** New branch `asi/<name>` from the current HEAD, checked out in `<dir>/<repo>/<name>`. */
    async create(workspacePath: string): Promise<Worktree> {
      const root = await repoRoot(workspacePath)
      try { await out(['rev-parse', '--verify', 'HEAD'], root) } catch { throw new Error('this repository has no commits yet, so there is nothing to branch from') }
      const branches = new Set((await out(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], root)).split('\n').filter(Boolean))
      const parent = join(o.dir, basename(root) || 'repo')
      await mkdir(parent, { recursive: true })
      let name = worktreeName(branches)
      while (existsSync(join(parent, name))) name = worktreeName(new Set([...branches, name]))
      const branch = `asi/${name}`
      const dest = join(parent, name)
      await out(['worktree', 'add', '-b', branch, dest], root)
      // pictures sent to the agent land in .attachments: keep them out of "uncommitted changes" (local, untracked file)
      try {
        const exclude = resolve(root, await out(['rev-parse', '--git-path', 'info/exclude'], root))
        await mkdir(dirname(exclude), { recursive: true })
        const cur = await readFile(exclude, 'utf8').catch(() => '')
        if (!cur.split('\n').includes('.attachments/')) await appendFile(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.attachments/\n`)
      } catch { /* cosmetic */ }
      const sub = relative(root, resolve(workspacePath))
      return { path: sub && !sub.startsWith('..') ? join(dest, sub) : dest, branch }
    },

    /** Number of changed or untracked files in a worktree (0 when clean or already gone). */
    async dirtyCount(path: string): Promise<number> {
      if (!existsSync(path)) return 0
      try { return (await out(['status', '--porcelain'], path)).split('\n').filter(Boolean).length } catch { return 0 }
    },

    /**
     * Take the worktree away, never losing work: a folder with uncommitted changes stays (nothing is forced),
     * and a branch with commits that are not merged is kept. `workspacePath` is the main repo it came from.
     */
    async remove(path: string, branch: string, workspacePath: string): Promise<RemoveResult> {
      let root: string
      try { root = await repoRoot(workspacePath) } catch (e) { return { removed: false, branchDeleted: false, note: e instanceof Error ? e.message : String(e) } }
      if (existsSync(path)) {
        const dirty = await this.dirtyCount(path)
        if (dirty > 0) return { removed: false, branchDeleted: false, note: `kept ${path}: it has ${dirty} uncommitted change${dirty === 1 ? '' : 's'}` }
        try {
          await out(['worktree', 'remove', await repoRoot(path)], root)
        } catch (e) {
          return { removed: false, branchDeleted: false, note: `could not remove ${path}: ${e instanceof Error ? e.message : String(e)}` }
        }
      } else {
        await out(['worktree', 'prune'], root).catch(() => '') // the folder was deleted by hand: drop git's record of it
      }
      try {
        await out(['branch', '-d', branch], root)
        return { removed: true, branchDeleted: true, note: null }
      } catch {
        return { removed: true, branchDeleted: false, note: `kept branch ${branch}: it has commits that are not merged` }
      }
    }
  }
}

export type Worktrees = ReturnType<typeof createWorktrees>
