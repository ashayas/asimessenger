import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('label a chat with ⌘L and a friend from the list, then browse both in the Labels tab', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'auth refactor' })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await expect(chat.getByTestId('transcript')).toBeVisible()
    await chat.keyboard.press('Meta+l')
    await chat.getByLabel('New label').fill('infra')
    await chat.getByLabel('New label').press('Enter')
    await expect(chat.locator('.lchip[data-label="infra"]')).toBeVisible()
    await chat.getByLabel('New label').fill('urgent')
    await chat.getByLabel('New label').press('Enter')
    await expect(chat.locator('.lchip')).toHaveCount(2)
    await chat.getByLabel('Label urgent').uncheck()
    await expect(chat.locator('.lchip')).toHaveCount(1)
    await chat.screenshot({ path: 'test-results/labels.png' })

    // label the friend with the existing label
    await h.win.locator('[data-friend="Fake"]').click()
    await h.win.getByRole('button', { name: /Label selected friend/ }).click()
    await h.win.getByLabel('Label infra').check()
    await expect(h.win.locator('[data-friend="Fake"] .lchip[data-label="infra"]')).toBeVisible()

    await h.win.getByRole('tab', { name: 'Labels' }).click()
    const group = h.win.locator('[data-label-group="infra"]')
    await expect(group).toContainText('infra (2)')
    await expect(group.locator('[data-friend="Fake"]')).toBeVisible()
    await expect(group.locator('[data-chat="auth refactor"]')).toBeVisible()
    await expect(h.win.locator('[data-label-group="urgent"]')).toContainText('urgent (0)')
  } finally {
    await h.cleanup()
  }
})
