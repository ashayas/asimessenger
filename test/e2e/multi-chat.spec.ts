import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('five Claude Codes in one workspace stay distinguishable: nested under the friend, ranked in Chats, scoped to the workspace', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'asi-multi-bin-'))
  for (const [c, v] of [['claude', '2.1.289 (Claude Code)'], ['codex', 'codex-cli 0.160.0']]) { writeFileSync(join(bin, c!), `#!/bin/sh\necho "${v}"\n`); chmodSync(join(bin, c!), 0o755) }
  const h = await launchApp({ seed: true, env: { ASI_TEST_PATH: `${bin}:/usr/bin:/bin` } })
  try {
    await h.win.evaluate(async () => {
      const api = window.asi.api
      await api.settings.set('profile', { name: 'Ashaya', personalMessage: '<five claudes, one repo>', presence: 'online' })
      const home = (await api.workspaces.list())[0]!
      await api.workspaces.rename(home.id, 'honeycomb')
      const other = await api.workspaces.create({ name: 'fantasy', path: '/tmp/fantasy' })
      const claude = await api.friends.create({ harness: 'claude', displayName: 'Claude Code', avatar: 'claude', command: 'claude' })
      const codex = await api.friends.create({ harness: 'codex', displayName: 'Codex', avatar: 'codex', command: 'codex' })
      const mk = (ws: string, friend: string, title: string) => api.chats.create({ workspaceId: ws, friendId: friend, title })
      const a = await mk(home.id, claude.id, 'auth refactor')
      const b = await mk(home.id, claude.id, 'flaky session test')
      const c = await mk(home.id, claude.id, 'migrate to vite 7')
      const d = await mk(home.id, claude.id, 'docs pass')
      const e = await mk(home.id, claude.id, 'rate limiting')
      const x = await mk(home.id, codex.id, 'build fix')
      await mk(other.id, claude.id, 'chapter 3 outline') // another workspace: must not show here
      await api.chats.setStatus(a.id, 'away', '(⊙_⊙) waiting on u: rm -rf dist')
      await api.chats.setStatus(b.id, 'busy', '✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧ session.test.ts')
      await api.chats.setStatus(c.id, 'busy', '~*~ editing vite.config.ts ~*~')
      await api.chats.setStatus(d.id, 'online', 'all done ★')
      await api.chats.setStatus(e.id, 'online', null)
      await api.chats.setStatus(x.id, 'busy', '~*~ fixing the build ~*~')
      await api.chats.setMode(e.id, 'dangerous')
      await api.messages.append({ chatId: d.id, role: 'agent', kind: 'text', body: { text: 'Docs updated.' }, text: 'Docs updated.' })
      await api.messages.append({ chatId: d.id, role: 'agent', kind: 'text', body: { text: 'Want me to open a PR?' }, text: 'Want me to open a PR?' })
      await api.messages.append({ chatId: a.id, role: 'agent', kind: 'text', body: { text: 'Delete dist?' }, text: 'Delete dist?' })
    })

    // Friends tab: one Claude Code row, ×5, its five chats nested, urgency first; the other workspace's chat is absent
    const row = h.win.locator('[data-friend="Claude Code"]')
    await expect(row).toContainText('×5')
    await expect(row).toHaveAttribute('data-presence', 'away') // the most urgent of its chats
    await expect(h.win.locator('[data-subchat]')).toHaveCount(5)
    await expect(h.win.locator('[data-subchat]').first()).toHaveAttribute('data-subchat', 'auth refactor')
    await expect(h.win.locator('[data-subchat="chapter 3 outline"]')).toHaveCount(0)
    await h.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('#/contacts')); w?.setBounds({ x: 40, y: 50, width: 340, height: 820 }) })
    await h.win.waitForTimeout(500)
    await h.win.screenshot({ path: 'test-results/multi-friends.png' })

    // collapsing hides the nested rows
    await row.getByRole('button', { name: /×5/ }).click()
    await expect(h.win.locator('[data-subchat]')).toHaveCount(0)
    await row.getByRole('button', { name: /×5/ }).click()
    await expect(h.win.locator('[data-subchat]')).toHaveCount(5)

    // Chats tab: every chat of this workspace, needs-you first, then working, each with its friend and status
    await h.win.getByRole('tab', { name: /^Chats/ }).click()
    const rows = h.win.locator('[data-chat]')
    await expect(rows).toHaveCount(6)
    await expect(rows.nth(0)).toHaveAttribute('data-chat', 'auth refactor')
    await expect(rows.nth(0)).toHaveAttribute('data-presence', 'away')
    expect(await rows.evaluateAll((els) => els.slice(1, 4).map((e) => e.getAttribute('data-presence')))).toEqual(['busy', 'busy', 'busy'])
    await expect(h.win.locator('[data-chat="build fix"]')).toContainText('Codex')
    await expect(h.win.locator('[data-chat="docs pass"] .badge')).toHaveText('2')
    await h.win.screenshot({ path: 'test-results/multi-chats.png' })
  } finally {
    await h.cleanup()
  }
})
