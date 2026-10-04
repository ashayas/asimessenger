import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('open an agent attachment, reply to a selected line, and see the quote in the chat', async () => {
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
    await chat.getByLabel('Message').fill('/script attachment')
    await chat.getByLabel('Message').press('Enter')
    await expect(chat.locator('[data-kind="attachment"]')).toContainText('refresh-race.md')

    const viewerP = h.app.waitForEvent('window')
    await chat.locator('[data-kind="attachment"]').getByRole('button', { name: 'Open' }).click()
    const viewer = await viewerP
    await expect(viewer.getByTestId('viewer').locator('h1')).toHaveText('Root cause')
    // select the paragraph, then reply
    await viewer.getByText('The refresh runs twice under concurrent calls.').selectText()
    await expect(viewer.getByTestId('quoting')).toContainText('your selection')
    await viewer.getByLabel('Reply').fill('why twice?')
    await viewer.getByRole('button', { name: 'Send reply' }).click()
    await expect(viewer.getByTestId('quoting')).toContainText('Sent to Fake')

    await expect(chat.getByTestId('quote')).toContainText('The refresh runs twice')
    await expect(chat.getByTestId('quote')).toContainText('refresh-race.md')
    await expect(chat.getByText('You said: why twice?')).toBeVisible() // agent saw the reply
    await viewer.screenshot({ path: 'test-results/viewer.png' })
  } finally {
    await h.cleanup()
  }
})

test('Send Files attaches a text file to the transcript and shows it to the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asi-files-'))
  const file = join(dir, 'notes.ts')
  writeFileSync(file, 'export const answer = 42\n')
  const h = await launchApp({ env: { ASI_TEST_FILES: JSON.stringify([file]) } })
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await chat.getByRole('button', { name: 'Send Files' }).click()
    await expect(chat.locator('[data-kind="attachment"]')).toContainText('notes.ts')
    await expect(chat.getByText(/You said: I'm attaching notes\.ts/)).toBeVisible()
    const viewerP = h.app.waitForEvent('window')
    await chat.locator('[data-kind="attachment"]').getByRole('button', { name: 'Open' }).click()
    const viewer = await viewerP
    await expect(viewer.getByTestId('viewer')).toContainText('export const answer = 42')
  } finally {
    await h.cleanup()
  }
})
