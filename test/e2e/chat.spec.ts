import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('double-click opens a chat window; the transcript persists across restart; new chat is a new thread', async () => {
  const h = await launchApp({ seed: true })
  try {
    const opened = h.app.waitForEvent('window')
    await h.win.locator('[data-friend="Echo"]').dblclick()
    const chat = await opened
    await chat.getByLabel('Message').fill('hello there')
    await chat.getByLabel('Message').press('Enter')
    await expect(chat.locator('.msg').nth(1)).toHaveText('echo: hello there')
    await expect(chat.locator('.says').first()).toContainText('says:')
    await chat.screenshot({ path: 'test-results/chat.png' })

    // chat got auto-titled from the first message and shows in the Chats tab
    await h.win.getByRole('tab', { name: 'Chats' }).click()
    await expect(h.win.locator('[data-chat="hello there"]')).toBeVisible()

    await h.restart()
    await h.win.getByRole('tab', { name: 'Chats' }).click()
    const reopened = h.app.waitForEvent('window')
    await h.win.locator('[data-chat="hello there"]').dblclick()
    const again = await reopened
    await expect(again.locator('.msg')).toHaveText(['hello there', 'echo: hello there'])

    // a new chat with the same friend is a separate, empty thread
    await h.win.getByRole('tab', { name: 'Friends' }).click()
    await h.win.locator('[data-friend="Echo"]').click()
    const fresh = h.app.waitForEvent('window')
    await h.win.getByRole('button', { name: /New chat with selected friend/ }).click()
    const second = await fresh
    await expect(second.getByText('Say something to Echo.')).toBeVisible()
  } finally {
    await h.cleanup()
  }
})
