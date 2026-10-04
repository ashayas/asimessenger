import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('contact list groups friends by what they are doing', async () => {
  const h = await launchApp()
  try {
    await h.win.evaluate(async () => {
      const api = window.asi.api
      const ws = await api.workspaces.create({ name: 'honeycomb', path: '/tmp/hc', slot: 1 })
      const asi = await api.friends.create({ harness: 'asi', displayName: 'ASI' })
      const claude = await api.friends.create({ harness: 'claude', displayName: 'Claude Code' })
      const codex = await api.friends.create({ harness: 'codex', displayName: 'Codex' })
      await api.friends.create({ harness: 'acp', avatar: 'pi', displayName: 'Pi', command: 'pi-acp', transport: 'generic' })
      const c1 = await api.chats.create({ workspaceId: ws.id, friendId: claude.id, title: 'auth' })
      await api.chats.setStatus(c1.id, 'busy', 'running tests')
      const c2 = await api.chats.create({ workspaceId: ws.id, friendId: codex.id, title: 'build' })
      await api.chats.setStatus(c2.id, 'away', 'waiting on u: rm -rf dist')
      void asi
    })
    await expect(h.win.locator('[data-group="asi"] .contact')).toHaveCount(1)
    await expect(h.win.locator('[data-group="working"] [data-friend="Claude Code"]')).toHaveAttribute('data-presence', 'busy')
    await expect(h.win.locator('[data-group="needs-you"] [data-friend="Codex"]')).toContainText('waiting on u')
    await expect(h.win.locator('[data-group="offline"] [data-friend="Pi"]')).toBeVisible()
    await h.win.getByLabel('Find a friend').fill('codex')
    await expect(h.win.locator('.contact')).toHaveCount(1)
    await h.win.screenshot({ path: 'test-results/contacts.png' })
  } finally {
    await h.cleanup()
  }
})

test('status and personal message persist across restart', async () => {
  const h = await launchApp({ seed: true })
  try {
    await h.win.getByLabel('Personal message').fill('shipping asi messenger')
    await h.win.getByLabel('Your status').selectOption('busy')
    await expect.poll(() => h.win.evaluate(() => window.asi.api.settings.get('profile', null))).toMatchObject({ presence: 'busy' })
    await h.restart()
    await expect(h.win.getByLabel('Personal message')).toHaveValue('shipping asi messenger')
    await expect(h.win.getByLabel('Your status')).toHaveValue('busy')
  } finally {
    await h.cleanup()
  }
})
