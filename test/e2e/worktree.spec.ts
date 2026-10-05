import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

test('a new chat in its own worktree: branch chip, separate folder, safe delete', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'asi-e2e-wt-')))
  const repo = join(root, 'honeycomb'); mkdirSync(repo)
  sh(root, 'init', '-q', repo)
  writeFileSync(join(repo, 'README.md'), '# hi\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init')
  const plain = join(root, 'notes'); mkdirSync(plain)
  const h = await launchApp()
  try {
    await h.win.evaluate(async ([r, p]) => {
      const api = window.asi.api
      await api.workspaces.create({ name: 'honeycomb', path: r! })
      await api.workspaces.create({ name: 'notes', path: p! })
      await api.friends.create({ harness: 'fake', displayName: 'Fake' })
    }, [repo, plain])
    await h.win.getByRole('tab', { name: /honeycomb/ }).click()
    const fake = h.win.locator('[data-friend="Fake"]')
    await fake.click()

    // two isolated chats in the same repo
    for (let i = 0; i < 2; i++) {
      const opened = h.app.waitForEvent('window')
      await h.win.getByRole('button', { name: /own worktree/ }).click()
      const chat = await opened
      await expect(chat.getByTestId('branch')).toContainText('⎇ asi/')
    }
    const dirs = readdirSync(join(h.userData, 'worktrees', 'honeycomb'))
    expect(dirs).toHaveLength(2)
    expect(sh(repo, 'worktree', 'list').split('\n')).toHaveLength(3)
    expect(sh(repo, 'status', '--porcelain')).toBe('') // the repo itself is untouched

    // the Chats tab tells them apart by branch
    await h.win.getByRole('tab', { name: /^Chats/ }).click()
    await expect(h.win.locator('[data-chat] .branch')).toHaveCount(2)

    // a folder that is not a repo explains itself and creates nothing
    await h.win.getByRole('tab', { name: /^Friends/ }).click()
    await h.win.getByRole('tab', { name: /notes/ }).click()
    await h.win.locator('[data-friend="Fake"]').click()
    await h.win.getByRole('button', { name: /own worktree/ }).click()
    await expect(h.win.getByRole('status').filter({ hasText: 'not a git repository' })).toBeVisible()

    // delete one chat: its clean worktree and branch go, the other stays
    const win = h.app.windows().find((w) => w.url().includes('#/chat/'))!
    const gone = win.waitForEvent('close')
    await win.getByRole('button', { name: /Delete/ }).first().click()
    await expect(win.getByTestId('delete-confirm')).toContainText('removed if clean')
    await win.getByTestId('delete-confirm').getByRole('button', { name: 'Delete', exact: true }).click()
    await gone
    await expect.poll(() => readdirSync(join(h.userData, 'worktrees', 'honeycomb')).length).toBe(1)
    expect(sh(repo, 'worktree', 'list').split('\n')).toHaveLength(2)
    expect(existsSync(repo)).toBe(true)
  } finally {
    await h.cleanup()
  }
})
