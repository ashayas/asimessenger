import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('local links from the agent open in the in-app browser; shell blocks and /open work from the composer', async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Hello Preview</title><h1>hello browser</h1>') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
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
    const say = async (t: string) => { await chat.getByLabel('Message').fill(t); await chat.getByLabel('Message').press('Enter') }

    // the agent mentions a dev server -> chip -> browser
    await say(`dev server is at ${url}`)
    const chip = chat.getByTestId('local-links').getByRole('button')
    await expect(chip).toContainText(url)
    await chip.click()
    // web pages are windows too; the browser chrome is the one on the /browser route
    await expect.poll(() => h.app.windows().some((w) => w.url().includes('#/browser'))).toBe(true)
    const browser = h.app.windows().find((w) => w.url().includes('#/browser'))!
    await expect(browser.getByRole('tab', { name: /Hello Preview/ })).toBeVisible({ timeout: 10_000 })
    await expect(browser.getByLabel('Address')).toHaveValue(url)
    expect(await h.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().includes('127.0.0.1') && w.getTitle() === 'Hello Preview'))).toBe(true)
    await browser.screenshot({ path: 'test-results/browser.png' })

    // navigation is limited to the web
    await browser.getByLabel('Address').fill('file:///etc/passwd')
    await browser.getByLabel('Address').press('Enter')
    await browser.getByLabel('Address').fill('example.com')
    await browser.getByRole('button', { name: 'New tab' }).click()
    await expect(browser.getByRole('tab')).toHaveCount(2)
    expect(await h.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().startsWith('file:///etc')))).toBe(false)

    // "!cmd" shell block and "/open" system line
    await say('!echo hello-from-shell')
    await chat.locator('[data-kind="tool"] .h').last().click()
    await expect(chat.locator('[data-kind="tool"] pre.o').last()).toContainText('hello-from-shell')
    await say('/open ./')
    await expect(chat.locator('[data-kind="system"]').last()).toContainText('Opened')
  } finally {
    server.close()
    await h.cleanup()
  }
})
