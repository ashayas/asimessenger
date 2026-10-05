import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('paste or drop a picture: it waits in the tray, goes with your message, shows as a thumbnail, and lands in the workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asi-e2e-img-'))
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async (d) => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: d })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    }, dir)
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    const box = chat.getByLabel('Message')
    await expect(box).toBeVisible()

    // paste a picture from the clipboard
    await box.evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PNG_B64)
    await expect(chat.getByTestId('pending-file')).toHaveCount(1)

    // drop a second one onto the conversation
    await chat.locator('.convo').evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, PNG_B64)
    await expect(chat.getByTestId('pending-file')).toHaveCount(2)

    // one is removed again, then the message goes out with the other
    await chat.getByRole('button', { name: /Remove dropped\.png/ }).click()
    await expect(chat.getByTestId('pending-file')).toHaveCount(1)
    await box.fill('what is this?')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(chat.getByTestId('thumb')).toBeVisible()
    await expect(chat.locator('.block[data-role="user"]').getByText('what is this?')).toBeVisible() // your note is in the transcript
    await expect(chat.getByTestId('pending-file')).toHaveCount(0)
    await expect(chat.getByText(/You said: what is this\?/)).toBeVisible() // the agent got the note
    await expect(chat.getByText(/\.attachments\/image-\d+\.png/)).toBeVisible() // and where the picture lives

    const saved = readdirSync(join(dir, '.attachments'))
    expect(saved.filter((f) => f.startsWith('image-'))).toHaveLength(1)
    expect(existsSync(join(dir, '.attachments', saved.find((f) => f.startsWith('image-'))!))).toBe(true)
    await chat.screenshot({ path: 'test-results/image-attach.png' })
  } finally {
    await h.cleanup()
  }
})
