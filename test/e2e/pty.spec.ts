import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('a bring-your-own raw terminal friend: transcript gets plain output, the drawer is a live terminal', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'pty', displayName: 'Shell', command: '/bin/sh', args: [] })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await expect(chat.getByTestId('transcript')).toBeVisible()

    await chat.getByLabel('Message').fill('echo from-the-composer')
    await chat.getByLabel('Message').press('Enter')
    await expect(chat.locator('[data-kind="text"]', { hasText: 'from-the-composer' }).last()).toBeVisible({ timeout: 10_000 })

    // open the drawer: it shows the same session, and typing in it reaches the shell
    await chat.getByRole('button', { name: 'Terminal' }).click()
    const term = chat.getByTestId('terminal')
    await expect(term).toBeVisible()
    await expect(term.locator('.xterm-rows')).toContainText('from-the-composer', { timeout: 10_000 })
    await term.click()
    await chat.keyboard.type('echo typed-in-xterm')
    await chat.keyboard.press('Enter')
    await expect(term.locator('.xterm-rows')).toContainText('typed-in-xterm', { timeout: 10_000 })
    await chat.screenshot({ path: 'test-results/pty.png' })

    // Nudge (Ctrl-C) stops a long command
    await chat.getByLabel('Message').fill('sleep 30')
    await chat.getByLabel('Message').press('Enter')
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.status, chatId)).toBe('busy')
    await chat.getByRole('button', { name: 'Stop' }).click()
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.statusText, chatId)).toContain('stopped')
  } finally {
    await h.cleanup()
  }
})
