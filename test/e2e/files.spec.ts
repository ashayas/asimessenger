import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('drop or paste any file: it waits in the tray as a file chip, goes with your message, and lands as a file card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asi-e2e-files-'))
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

    // a csv and a binary spreadsheet dropped together (a File with no path on disk behaves like a pasted one)
    await chat.locator('.convo').evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['region,amount\nnorth,10\nsouth,32\n'], 'sales.csv', { type: 'text/csv' }))
      dt.items.add(new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0xff, 0xfe, 1, 2, 3])], 'Q3 book.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    const chips = chat.getByTestId('pending-file')
    await expect(chips).toHaveCount(2)
    await expect(chips.nth(0)).toContainText('CSV')
    await expect(chips.nth(0)).toContainText('sales.csv')
    await expect(chips.nth(1)).toContainText('XLSX')
    await expect(chips.nth(1)).toContainText('B') // sizes show on the chip

    await box.fill('what is the total?')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()

    const cards = chat.locator('[data-attachment-kind="file"]')
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0)).toContainText('sales.csv')
    await expect(cards.nth(0)).toContainText('32 B')
    await expect(cards.nth(0).getByRole('button', { name: 'Open' })).toBeVisible()
    await expect(cards.nth(0).getByRole('button', { name: 'Show in Finder' })).toBeVisible()
    await expect(chat.locator('.block[data-role="user"]').getByText('what is the total?')).toBeVisible()
    await expect(chat.getByText(/saved at .*\.attachments\/[^/\s]+\/sales\.csv/)).toBeVisible() // the agent was told where it is
    await expect(chat.getByText('north,10')).toHaveCount(0) // and the contents were not pasted into the chat

    const saved = readdirSync(join(dir, '.attachments'), { recursive: true }).map(String)
    expect(saved.some((f) => /^[^/]+\/sales\.csv$/.test(f))).toBe(true)
    expect(saved.some((f) => /^[^/]+\/Q3-book\.xlsx$/.test(f))).toBe(true)
    expect(existsSync(join(dir, '.attachments'))).toBe(true)
    await chat.screenshot({ path: 'test-results/file-cards.png' })
  } finally {
    await h.cleanup()
  }
})
