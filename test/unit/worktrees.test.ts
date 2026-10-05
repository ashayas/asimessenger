import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createWorktrees } from '../../src/main/worktrees'
import { worktreeName } from '../../src/shared/worktree-names'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
let base: string
let repo: string
let wt: ReturnType<typeof createWorktrees>
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'asi-wt-')))
  repo = join(base, 'honeycomb')
  mkdirSync(join(repo, 'packages/api'), { recursive: true })
  sh(base, 'init', '-q', repo)
  writeFileSync(join(repo, 'README.md'), '# hi\n')
  writeFileSync(join(repo, 'packages/api/index.ts'), 'export {}\n')
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init')
  wt = createWorktrees({ dir: join(base, 'worktrees') })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('names', () => {
  test('are branch-safe, avoid existing branches, and grow on collision', () => {
    const n = worktreeName(new Set())
    expect(n).toMatch(/^[a-z]+-[a-z]+$/)
    const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5]
    let i = 0
    const rng = () => seq[i++ % seq.length]!
    const first = worktreeName(new Set(), () => 0)
    expect(worktreeName(new Set([first, `asi/${first}`]), rng).split('-').length).toBeGreaterThanOrEqual(2)
    expect(worktreeName(new Set(['anything']), () => 0.1)).not.toBe('anything')
    // everything taken: a numbered fallback still produces something usable
    const all = { has: () => true } as unknown as ReadonlySet<string>
    expect(worktreeName(all)).toMatch(/^chat-\d+$/)
  })
})

describe('git worktrees for isolated chats', () => {
  test('creates asi/<name> in a folder outside the repo, from the current HEAD', async () => {
    const w = await wt.create(repo)
    expect(w.branch).toMatch(/^asi\/[a-z-]+$/)
    expect(w.path.startsWith(join(base, 'worktrees', 'honeycomb'))).toBe(true)
    expect(w.path.startsWith(repo)).toBe(false)
    expect(readFileSync(join(w.path, 'README.md'), 'utf8')).toBe('# hi\n')
    expect(sh(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(w.branch)
    expect(sh(repo, 'status', '--porcelain')).toBe('') // the main checkout is untouched
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe(w.branch)
  })

  test('two chats get two different branches and folders', async () => {
    const a = await wt.create(repo)
    const b = await wt.create(repo)
    expect(a.branch).not.toBe(b.branch)
    expect(a.path).not.toBe(b.path)
    writeFileSync(join(a.path, 'only-in-a.txt'), 'x')
    expect(existsSync(join(b.path, 'only-in-a.txt'))).toBe(false)
  })

  test('a workspace that is a sub-folder of a repo gets the same sub-folder inside the worktree', async () => {
    const w = await wt.create(join(repo, 'packages/api'))
    expect(w.path.endsWith(join('packages', 'api'))).toBe(true)
    expect(existsSync(join(w.path, 'index.ts'))).toBe(true)
  })

  test('refuses a folder that is not a repo, and a repo with no commits', async () => {
    const plain = join(base, 'plain'); mkdirSync(plain)
    await expect(wt.create(plain)).rejects.toThrow(/not a git repository/)
    expect(await wt.isRepo(plain)).toBe(false)
    expect(await wt.isRepo(repo)).toBe(true)
    const empty = join(base, 'empty'); mkdirSync(empty); sh(base, 'init', '-q', empty)
    await expect(wt.create(empty)).rejects.toThrow(/no commits/)
  })

  test('pictures in .attachments do not count as uncommitted changes', async () => {
    const w = await wt.create(repo)
    mkdirSync(join(w.path, '.attachments')); writeFileSync(join(w.path, '.attachments/shot.png'), 'x')
    expect(await wt.dirtyCount(w.path)).toBe(0)
    writeFileSync(join(w.path, 'real.txt'), 'x')
    expect(await wt.dirtyCount(w.path)).toBe(1)
  })

  test('removing a clean, untouched worktree takes the folder and the branch', async () => {
    const w = await wt.create(repo)
    const r = await wt.remove(w.path, w.branch, repo)
    expect(r).toEqual({ removed: true, branchDeleted: true, note: null })
    expect(existsSync(w.path)).toBe(false)
    expect(sh(repo, 'branch', '--list', w.branch)).toBe('')
  })

  test('uncommitted work is never removed, and nothing is forced', async () => {
    const w = await wt.create(repo)
    writeFileSync(join(w.path, 'wip.txt'), 'precious')
    const r = await wt.remove(w.path, w.branch, repo)
    expect(r.removed).toBe(false)
    expect(r.note).toMatch(/1 uncommitted change/)
    expect(readFileSync(join(w.path, 'wip.txt'), 'utf8')).toBe('precious')
  })

  test('committed but unmerged work: the folder goes, the branch (and the work) stays', async () => {
    const w = await wt.create(repo)
    writeFileSync(join(w.path, 'feature.txt'), 'done')
    sh(w.path, 'add', '-A'); sh(w.path, 'commit', '-qm', 'feature')
    const r = await wt.remove(w.path, w.branch, repo)
    expect(r.removed).toBe(true)
    expect(r.branchDeleted).toBe(false)
    expect(r.note).toMatch(/kept branch/)
    expect(sh(repo, 'show', `${w.branch}:feature.txt`)).toBe('done')
  })

  test('once merged, the branch is deleted with the folder', async () => {
    const w = await wt.create(repo)
    writeFileSync(join(w.path, 'feature.txt'), 'done')
    sh(w.path, 'add', '-A'); sh(w.path, 'commit', '-qm', 'feature')
    sh(repo, 'merge', '-q', w.branch)
    expect((await wt.remove(w.path, w.branch, repo)).branchDeleted).toBe(true)
  })

  test('a folder deleted by hand is tidied up without error', async () => {
    const w = await wt.create(repo)
    rmSync(w.path, { recursive: true, force: true })
    const r = await wt.remove(w.path, w.branch, repo)
    expect(r.removed).toBe(true)
    expect(sh(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})
