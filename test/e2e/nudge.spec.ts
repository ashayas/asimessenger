import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('Nudge interrupts the agent, plays the sound, shakes the window and ends where it started', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await chat.getByLabel('Message').fill('/script long')
    await chat.getByLabel('Message').press('Enter')
    await expect(chat.locator('[data-running]')).toBeVisible()

    // watch the chat window's x position from the main process
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes('Fake'))!
      const g = globalThis as unknown as { __xs: number[]; __win: Electron.BrowserWindow }
      g.__xs = [w.getBounds().x]
      g.__win = w
      w.on('move', () => g.__xs.push(w.getBounds().x))
    })
    await chat.getByRole('button', { name: 'Nudge' }).click()
    await expect(chat.locator('[data-kind="nudge"]')).toContainText('stopped the agent')
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.statusText, chatId)).toContain('stopped')
    await chat.waitForTimeout(500) // let the shake finish
    const xs = await h.app.evaluate(() => (globalThis as unknown as { __xs: number[] }).__xs)

    expect(await chat.evaluate(() => (window as unknown as { __sounds: string[] }).__sounds)).toContain('nudge')
    expect(new Set(xs).size).toBeGreaterThan(3) // it moved around
    expect(xs.at(-1)).toBe(xs[0]) // and came back to where it started

    // a second nudge inside the cooldown does nothing
    await chat.getByRole('button', { name: 'Nudge' }).click()
    await chat.waitForTimeout(300)
    await expect(chat.locator('[data-kind="nudge"]')).toHaveCount(1)
  } finally {
    await h.cleanup()
  }
})
