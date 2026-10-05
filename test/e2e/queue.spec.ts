import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('queue your next prompt while the agent works: held, sent on success, kept when the agent is stopped', async () => {
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
    const box = chat.getByLabel('Message')
    const say = async (t: string) => { await box.fill(t); await box.press('Enter') }

    // 1. the agent waits on a permission (busy from your side): queue a follow-up with /queue
    await say('/script permission')
    await expect(chat.getByRole('button', { name: 'Allow once' })).toBeVisible()
    await say('/queue then summarize the result')
    const q = chat.getByTestId('queued')
    await expect(q).toContainText('then summarize the result')
    await expect(q).toContainText('Sends when the agent finishes')
    await chat.screenshot({ path: 'test-results/queued.png' })
    await expect(chat.getByText('You said: then summarize the result')).toHaveCount(0) // not sent yet

    // 2. answering lets the turn finish, and the queued prompt follows by itself
    await chat.getByRole('button', { name: 'Allow once' }).click()
    await expect(chat.getByText('You said: then summarize the result')).toBeVisible()
    await expect(q).toHaveCount(0)

    // 3. a stopped agent does not receive it: it waits for you, and Edit brings it back to the box
    await say('/script long')
    await expect(chat.getByRole('button', { name: /Queue next/ })).toBeVisible() // the toggle shows while the agent works
    await chat.getByRole('button', { name: /Queue next/ }).click()
    await say('after the long task')
    await expect(q).toContainText('after the long task')
    await chat.getByRole('button', { name: 'Stop' }).click()
    await expect(q).toHaveAttribute('data-held', 'true')
    await expect(q).toContainText('The agent stopped, so this was not sent')
    await expect(chat.getByText('You said: after the long task')).toHaveCount(0)
    await q.getByRole('button', { name: 'Edit' }).click()
    await expect(q).toHaveCount(0)
    await expect(box).toHaveValue('after the long task')
  } finally {
    await h.cleanup()
  }
})
