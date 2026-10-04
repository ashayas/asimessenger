import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'

test('data written through IPC survives an app restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'asi-e2e-'))
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ASI_USER_DATA: userData } })
  try {
    let app = await launch()
    let win = await app.firstWindow()
    await win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'honeycomb', path: '/tmp/hc', slot: 1 })
      const f = await window.asi.api.friends.create({ harness: 'echo', displayName: 'Echo' })
      await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'first chat' })
    })
    await app.close()

    app = await launch()
    win = await app.firstWindow()
    const titles = await win.evaluate(async () => (await window.asi.api.chats.list()).map((c) => c.title))
    expect(titles).toEqual(['first chat'])
    const hits = await win.evaluate(() => window.asi.api.search.query('first'))
    expect(hits[0]).toMatchObject({ kind: 'chat', title: 'first chat' })
    await app.close()
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
