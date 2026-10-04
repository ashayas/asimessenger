import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('Options: sounds off silences Nudge, plain lettering changes the status line, export and delete-all', async () => {
  const exportPath = join(mkdtempSync(join(tmpdir(), 'asi-exp-')), 'export.json')
  const h = await launchApp({ env: { ASI_TEST_EXPORT_PATH: exportPath } })
  try {
    const { chatId, friendId } = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const c = await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'keep me?' })
      await window.asi.api.messages.append({ chatId: c.id, role: 'user', kind: 'text', body: {}, text: 'remember this' })
      return { chatId: c.id, friendId: f.id }
    })
    const optsP = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+,')
    const opts = await optsP

    // lettering: funky -> plain
    await opts.getByLabel('Lettering for Fake').selectOption('plain')
    await expect.poll(() => h.win.evaluate(async (id) => (await window.asi.api.friends.get(id))!.letteringStyle, friendId)).toBe('plain')

    // sounds off: the nudge sound is not played
    const chatP = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await chatP
    await expect(chat.getByTestId('transcript')).toBeVisible()
    await opts.getByLabel('Play sounds').uncheck()
    await expect.poll(() => h.win.evaluate(async () => window.asi.api.settings.get('soundsOn', true))).toBe(false)
    await chat.getByRole('button', { name: 'Nudge' }).click()
    await expect(chat.locator('[data-kind="nudge"]')).toBeVisible()
    expect(await chat.evaluate(() => (window as unknown as { __sounds?: string[] }).__sounds ?? [])).not.toContain('nudge')

    // export, then delete all chats
    await opts.getByRole('button', { name: 'Export all chats…' }).click()
    await expect(opts.getByRole('status')).toContainText('Exported to')
    expect(existsSync(exportPath)).toBe(true)
    expect(JSON.parse(readFileSync(exportPath, 'utf8')).chats[0].messages.some((m: { text: string }) => m.text === 'remember this')).toBe(true)
    await opts.getByRole('button', { name: 'Delete all chats…' }).click()
    await expect(opts.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    await opts.getByLabel('Type DELETE to confirm').fill('DELETE')
    await opts.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(opts.getByRole('status').last()).toContainText('Deleted 1 chat')
    expect(await h.win.evaluate(async () => (await window.asi.api.chats.list()).length)).toBe(0)
    await opts.screenshot({ path: 'test-results/options.png' })
  } finally {
    await h.cleanup()
  }
})
