import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('Doodle: draw, autosave into <workspace>/.drawings, send to chat as an image', async () => {
  const wsDir = mkdtempSync(join(tmpdir(), 'asi-doodle-'))
  const h = await launchApp()
  try {
    const { chatId, wsId } = await h.win.evaluate(async (path) => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const chat = await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })
      return { chatId: chat.id, wsId: ws.id }
    }, wsDir)
    const chatP = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await chatP
    await expect(chat.getByTestId('transcript')).toBeVisible()

    const doodleP = h.app.waitForEvent('window')
    await chat.getByRole('button', { name: 'Doodle' }).click()
    const doodle = await doodleP
    const canvas = doodle.locator('canvas.interactive')
    await expect(canvas).toBeVisible({ timeout: 20_000 })

    // draw a rectangle
    const box = (await canvas.boundingBox())!
    await doodle.getByTestId('toolbar-rectangle').click({ force: true })
    await expect(doodle.getByTestId('toolbar-rectangle')).toBeChecked()
    await doodle.mouse.move(box.x + 300, box.y + 300)
    await doodle.mouse.down()
    await doodle.mouse.move(box.x + 500, box.y + 420, { steps: 8 })
    await doodle.mouse.up()

    await expect(doodle.getByTestId('doodle-status')).toContainText('Saved', { timeout: 10_000 })
    const files = readdirSync(join(wsDir, '.drawings')).filter((f) => f.endsWith('.excalidraw'))
    expect(files).toHaveLength(1)
    const scene = JSON.parse(readFileSync(join(wsDir, '.drawings', files[0]!), 'utf8'))
    expect(scene.elements.filter((e: { type: string }) => e.type === 'rectangle')).toHaveLength(1)
    // fonts come from our own bundle (no network fallback needed)
    const loadedLocal = await doodle.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length)
    expect(loadedLocal).toBeGreaterThan(0)
    await doodle.screenshot({ path: 'test-results/doodle.png' })

    await doodle.getByRole('button', { name: 'Send to chat' }).click()
    await expect(chat.locator('[data-kind="attachment"]')).toContainText('.png')
    await expect(chat.getByText(/I drew a diagram for you/)).toBeVisible() // the agent got the path
    const base = files[0]!.replace('.excalidraw', '')
    expect(existsSync(join(wsDir, '.drawings', `${base}.png`))).toBe(true)

    // the image opens in the viewer
    const viewerP = h.app.waitForEvent('window')
    await chat.locator('[data-kind="attachment"]').getByRole('button', { name: 'Open' }).click()
    const viewer = await viewerP
    await expect(viewer.locator('.imgview img')).toBeVisible()
    void wsId
  } finally {
    await h.cleanup()
  }
})
