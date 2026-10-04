import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('⌘1-9 switch workspaces, chats are scoped, and the choice persists', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'asi-ws-'))
  const h = await launchApp({ env: { ASI_TEST_FOLDER: folder } })
  try {
    await h.win.evaluate(async () => {
      const api = window.asi.api
      const a = await api.workspaces.create({ name: 'honeycomb', path: '/tmp/hc' })
      const b = await api.workspaces.create({ name: 'fantasy', path: '/tmp/fa' })
      const f = await api.friends.create({ harness: 'echo', displayName: 'Echo' })
      await api.chats.create({ workspaceId: a.id, friendId: f.id, title: 'auth-refactor' })
      await api.chats.create({ workspaceId: b.id, friendId: f.id, title: 'draft-plot' })
    })
    await expect(h.win.locator('[data-workspace="honeycomb"]')).toHaveAttribute('aria-selected', 'true')
    await h.win.getByRole('tab', { name: 'Chats' }).click()
    await expect(h.win.locator('[data-chat]')).toHaveText(/auth-refactor/)

    await h.win.keyboard.press('Meta+2')
    await expect(h.win.locator('[data-workspace="fantasy"]')).toHaveAttribute('aria-selected', 'true')
    await expect(h.win.locator('[data-chat]')).toHaveText(/draft-plot/)

    await h.restart()
    await expect(h.win.locator('[data-workspace="fantasy"]')).toHaveAttribute('aria-selected', 'true')

    await h.win.getByLabel('Add workspace').click()
    const name = folder.split('/').pop()!
    await expect(h.win.locator(`[data-workspace="${name}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(h.win.locator(`[data-workspace="${name}"] .slot`)).toHaveText('⌘3')
  } finally {
    await h.cleanup()
  }
})
