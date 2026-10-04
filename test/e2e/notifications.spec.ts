import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('an agent that needs you while you are elsewhere pops a toast, badges the dock, and Open chat clears it', async () => {
  const h = await launchApp({ toasts: true })
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await chat.getByLabel('Message').fill('/script permission')

    // make sure the chat window is not the focused one
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#/contacts'))?.focus() })
    await expect.poll(() => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#/chat/'))?.isFocused())).toBe(false)
    const toastP = h.app.waitForEvent('window')
    await chat.getByLabel('Message').press('Enter')
    const toast = await toastP
    await expect(toast.getByTestId('toast')).toContainText('needs your OK')
    await expect(toast.getByTestId('toast')).toContainText('rm -rf dist')
    // rm -rf is high risk: no one-click Allow on the toast
    await expect(toast.getByRole('button', { name: 'Allow' })).toHaveCount(0)
    await toast.screenshot({ path: 'test-results/toast.png' })

    await expect.poll(() => h.app.evaluate(({ app }) => app.dock?.getBadge())).toBe('1')
    await expect(h.win.locator('.badge').first()).toBeVisible()

    await toast.getByRole('button', { name: 'Open chat' }).click()
    await expect.poll(() => h.app.windows().length).toBe(2) // contacts + chat; toast closed
    await chat.bringToFront()
    await chat.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => h.app.evaluate(({ app }) => app.dock?.getBadge())).toBe('')
  } finally {
    await h.cleanup()
  }
})

test('⌘⇧U opens the chat with the oldest unread', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const a = await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'older' })
      await window.asi.api.messages.append({ chatId: a.id, role: 'agent', kind: 'text', body: {}, text: 'hello' })
      const b = await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'newer' })
      await window.asi.api.messages.append({ chatId: b.id, role: 'agent', kind: 'text', body: {}, text: 'hi' })
      return a.id
    })
    await expect(h.win.getByTestId('contacts')).toBeVisible()
    await expect(h.win.getByRole('tab', { name: /Chats/ })).toContainText('2') // unread count arrived
    const opened = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+Shift+U')
    const chat = await opened
    await expect(chat.locator('.msg')).toHaveText(['hello'])
    void chatId
  } finally {
    await h.cleanup()
  }
})
