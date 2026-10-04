import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('push-to-talk records (capture is synthetic in tests), transcribes locally and types into the composer', async () => {
  const h = await launchApp({ env: { ASI_FAKE_RECORDER: '1', ASI_VOICE_FAKE: 'please run the tests' } })
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await expect(chat.getByTestId('transcript')).toBeVisible()

    await chat.getByLabel('Message').fill('hey')
    await chat.getByRole('button', { name: 'Voice Clip' }).click()
    await expect(chat.getByRole('status')).toContainText('Recording')
    await expect(chat.getByRole('button', { name: 'Stop & type' })).toBeVisible()
    await chat.waitForTimeout(800) // a real clip, long enough to count
    await chat.getByRole('button', { name: 'Stop & type' }).click()
    await expect(chat.getByLabel('Message')).toHaveValue('hey please run the tests', { timeout: 10_000 })
    await expect(chat.getByRole('status')).toHaveCount(0)
    await chat.screenshot({ path: 'test-results/voice.png' })

    // the hold-to-talk chord works too
    await chat.getByLabel('Message').fill('')
    await chat.keyboard.down('Alt')
    await chat.keyboard.down('Space')
    await expect(chat.getByRole('status')).toContainText('Recording')
    await chat.waitForTimeout(800)
    await chat.keyboard.up('Space')
    await chat.keyboard.up('Alt')
    await expect(chat.getByLabel('Message')).toHaveValue('please run the tests', { timeout: 10_000 })
  } finally {
    await h.cleanup()
  }
})
