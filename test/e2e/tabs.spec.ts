import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('tabs mode: one window per workspace, unread badges, drafts survive, pop out, cycle, restore', async () => {
  const h = await launchApp()
  try {
    const { a, b } = await h.win.evaluate(async () => {
      const api = window.asi.api
      await api.settings.set('chatWindows', 'tabs')
      const ws = await api.workspaces.create({ name: 'honeycomb', path: '/tmp' })
      const f = await api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const a = await api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'auth refactor' })
      const b = await api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'build fix' })
      await api.messages.append({ chatId: a.id, role: 'agent', kind: 'text', body: {}, text: 'message in auth' })
      await api.messages.append({ chatId: b.id, role: 'agent', kind: 'text', body: {}, text: 'message in build' })
      return { a: a.id, b: b.id }
    })
    const tabsOf = () => h.app.windows().filter((w) => w.url().includes('#/tabs/'))

    await h.win.evaluate((id) => window.asi.chat.openWindow(id), a)
    await expect.poll(() => tabsOf().length).toBe(1)
    const tabs = tabsOf()[0]!
    await expect(tabs.getByRole('tab', { name: /auth refactor/ })).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.locator('.msg')).toHaveText(['message in auth'])

    // opening a second chat adds a tab to the SAME window (no new window)
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), b)
    await expect(tabs.getByRole('tab')).toHaveCount(2)
    expect(tabsOf()).toHaveLength(1)
    await expect(tabs.getByRole('tab', { name: /build fix/ })).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.locator('.msg')).toHaveText(['message in build'])

    // a draft in one tab is still there after switching away and back
    await tabs.getByLabel('Message').fill('half-typed thought')
    await tabs.getByRole('tab', { name: /auth refactor/ }).click()
    await expect(tabs.locator('.msg')).toHaveText(['message in auth'])
    await expect(tabs.getByLabel('Message')).toHaveValue('')
    await tabs.getByRole('tab', { name: /build fix/ }).click()
    await expect(tabs.getByLabel('Message')).toHaveValue('half-typed thought')

    // a reply in the background tab shows an unread badge on it
    await tabs.getByRole('tab', { name: /auth refactor/ }).click()
    await h.win.evaluate((id) => window.asi.api.messages.append({ chatId: id, role: 'agent', kind: 'text', body: {}, text: 'ping' }), b)
    await expect(tabs.getByRole('tab', { name: /build fix/ }).locator('.badge')).toBeVisible()
    await tabs.screenshot({ path: 'test-results/tabs.png' })

    // keyboard cycling
    await tabs.keyboard.press('Meta+Shift+]')
    await expect(tabs.getByRole('tab', { name: /build fix/ })).toHaveAttribute('aria-selected', 'true')
    await tabs.keyboard.press('Meta+Shift+[')
    await expect(tabs.getByRole('tab', { name: /auth refactor/ })).toHaveAttribute('aria-selected', 'true')

    // pop a tab out into its own window
    const popP = h.app.waitForEvent('window')
    await tabs.getByRole('button', { name: 'Pop out build fix' }).click()
    const pop = await popP
    await expect(pop.getByTestId('transcript')).toBeVisible()
    expect(pop.url()).toContain(`#/chat/${b}`)
    await expect(tabs.getByRole('tab')).toHaveCount(1)

    // close the last tab, restart: the remembered tabs come back; deleted chats do not
    await h.restart()
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), a)
    await expect.poll(() => tabsOf().length).toBe(1)
    await expect(tabsOf()[0]!.getByRole('tab', { name: /auth refactor/ })).toBeVisible()
  } finally {
    await h.cleanup()
  }
})

test('windows mode is unchanged and the setting is respected live', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    expect((await opened).url()).toContain('#/chat/')
  } finally {
    await h.cleanup()
  }
})
