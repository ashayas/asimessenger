import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP = join(process.cwd(), 'release/mac-arm64/ASI Messenger.app/Contents/MacOS/ASI Messenger')

test('the packaged app starts, stores data (libsql), runs a pty, and serves its UI', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'asi-pkg-'))
  const app = await electron.launch({ executablePath: APP, env: { ...process.env, ASI_USER_DATA: userData, ASI_NO_TOAST: '1' } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByTestId('contacts')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('[data-friend="ASI"]')).toBeVisible()
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)

    // native module 1: libsql (the seed above already wrote through it); native module 2: node-pty
    const chatId = await win.evaluate(async () => {
      const ws = (await window.asi.api.workspaces.list())[0]!
      const f = await window.asi.api.friends.create({ harness: 'pty', displayName: 'Shell', command: '/bin/sh' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    await win.evaluate((id) => window.asi.chat.send(id, 'echo packaged-ok'), chatId)
    await expect.poll(async () => win.evaluate(async (id) => (await window.asi.api.messages.list(id)).map((m) => m.text).join('|'), chatId), { timeout: 15_000 }).toContain('packaged-ok')

    // sounds + fonts are bundled
    const fontsOk = await win.evaluate(async () => (await fetch('./excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2').catch(() => null))?.ok ?? false)
    expect(fontsOk).toBe(true)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
