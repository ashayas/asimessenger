import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('⌘K finds a message in another workspace and jumps to that chat', async () => {
  const h = await launchApp()
  try {
    await h.win.evaluate(async () => {
      const api = window.asi.api
      const a = await api.workspaces.create({ name: 'honeycomb', path: '/tmp/a' })
      const b = await api.workspaces.create({ name: 'fantasy', path: '/tmp/b' })
      const f = await api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const c1 = await api.chats.create({ workspaceId: a.id, friendId: f.id, title: 'auth refactor' })
      await api.messages.append({ chatId: c1.id, role: 'agent', kind: 'text', body: {}, text: 'nothing relevant here' })
      const c2 = await api.chats.create({ workspaceId: b.id, friendId: f.id, title: 'draft plot' })
      await api.messages.append({ chatId: c2.id, role: 'agent', kind: 'text', body: {}, text: 'the dragon flies at midnight' })
    })
    await expect(h.win.locator('[data-workspace="honeycomb"]')).toHaveAttribute('aria-selected', 'true')

    const paletteP = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+k')
    const palette = await paletteP
    await palette.getByLabel('Search').fill('dragon')
    const hit = palette.locator('[data-kind="message"]')
    await expect(hit).toHaveCount(1)
    await expect(hit).toContainText('draft plot')
    await expect(hit).toContainText('⌘2 fantasy')
    await palette.screenshot({ path: 'test-results/palette.png' })

    const chatP = h.app.waitForEvent('window')
    await palette.getByLabel('Search').press('Enter').catch(() => {}) // the palette closes itself mid-press
    const chat = await chatP
    await expect(chat.locator('.msg')).toHaveText(['the dragon flies at midnight'])
    // the contact list followed to the chat's workspace
    await expect(h.win.locator('[data-workspace="fantasy"]')).toHaveAttribute('aria-selected', 'true')
  } finally {
    await h.cleanup()
  }
})

test('empty and no-match states', async () => {
  const h = await launchApp()
  try {
    const paletteP = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+k')
    const palette = await paletteP
    await expect(palette.getByText('Type to search across every workspace.')).toBeVisible()
    await palette.getByLabel('Search').fill('qqqqzzzz')
    await expect(palette.getByText(/Nothing matches/)).toBeVisible()
  } finally {
    await h.cleanup()
  }
})
