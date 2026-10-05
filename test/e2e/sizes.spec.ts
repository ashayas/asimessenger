import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('a chat window works at its smallest messenger size and keeps a readable column when huge', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const c = await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'size check' })
      await window.asi.api.messages.append({ chatId: c.id, role: 'agent', kind: 'text', body: {}, text: 'a long reply '.repeat(60) })
      return c.id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await expect(chat.getByTestId('transcript')).toBeVisible()
    const resize = (w: number, ht: number) => h.app.evaluate(({ BrowserWindow }, [w2, h2]) => { const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('#/chat/'))!; win.setSize(w2 as number, h2 as number); return win.getSize() }, [w, ht] as const)

    // smallest: Electron clamps to the window's minimum, and nothing spills sideways or hides the composer
    const [minW, minH] = await resize(300, 200)
    expect(minW).toBeLessThanOrEqual(480)
    expect(minH).toBeLessThanOrEqual(380)
    await chat.waitForTimeout(300)
    expect(await chat.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(chat.getByLabel('Message')).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Nudge' })).toBeVisible()

    // huge: the conversation is a centred column, not text stretched across a 2500 px screen
    await resize(2400, 1200)
    await chat.waitForTimeout(300)
    const w = await chat.locator('.transcript .block').first().evaluate((el) => el.getBoundingClientRect().width)
    expect(w).toBeLessThan(1100)
    expect(await chat.getByLabel('Message').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(1100)
  } finally {
    await h.cleanup()
  }
})
