import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('every event kind renders and the permission/question round trips work', async () => {
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

    await say('/script tools')
    await expect(chat.locator('[data-kind="tool"]').first()).toContainText('pnpm vitest run')
    await chat.locator('[data-kind="tool"] .h').first().click()
    await expect(chat.locator('[data-kind="tool"] pre.o')).toContainText('1 failed')
    await expect(chat.getByText('Fixed the race in the refresh path.')).toBeVisible()

    await say('/script attachment')
    await expect(chat.locator('[data-kind="attachment"]')).toContainText('refresh-race.md')

    await say('/script permission')
    await expect(chat.locator('[data-kind="permission"][data-decision="pending"]')).toBeVisible()
    await chat.getByRole('button', { name: 'Allow once' }).click()
    await expect(chat.locator('[data-kind="permission"]')).toContainText('Allowed once')
    await expect(chat.getByText('Permission handled.')).toBeVisible()

    await say('/script question')
    await chat.getByRole('button', { name: 'Global' }).click()
    await expect(chat.locator('[data-kind="question"]')).toContainText('You answered: Global')

    // Nudge interrupts a long turn
    await say('/script long')
    await expect(chat.locator('[data-running]')).toBeVisible()
    await chat.getByRole('button', { name: 'Nudge' }).click()
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.statusText, chatId)).toContain('stopped')

    // Single-player controls: workspace chip, inline chat rename, Escape interrupt, ArrowUp recall, and Reset session
    await expect(chat.getByTestId('workspace-chip')).toContainText('w')
    await chat.getByRole('button', { name: 'Rename chat' }).click()
    await chat.getByLabel('Chat title').fill('refresh race fix')
    await chat.getByLabel('Chat title').press('Enter')
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.title, chatId)).toBe('refresh race fix')

    await say('/script long')
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.status, chatId)).toBe('busy')
    await chat.getByLabel('Message').press('Escape')
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.chats.get(id))!.status, chatId)).toBe('online')

    await chat.getByLabel('Message').press('ArrowUp')
    await expect(chat.getByLabel('Message')).toHaveValue('/script long')
    await chat.getByLabel('Message').fill('')

    await chat.getByRole('button', { name: 'Reset session' }).click()
    await expect(chat.getByText(/Session reset/)).toBeVisible()
    await chat.screenshot({ path: 'test-results/events.png' })
  } finally {
    await h.cleanup()
  }
})
