import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('data written through IPC survives an app restart', async () => {
  const h = await launchApp()
  try {
    await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'honeycomb', path: '/tmp/hc', slot: 1 })
      const f = await window.asi.api.friends.create({ harness: 'echo', displayName: 'Echo' })
      await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'first chat' })
    })
    await h.restart()
    const titles = await h.win.evaluate(async () => (await window.asi.api.chats.list()).map((c) => c.title))
    expect(titles).toEqual(['first chat'])
    const hits = await h.win.evaluate(() => window.asi.api.search.query('first'))
    expect(hits[0]).toMatchObject({ kind: 'chat', title: 'first chat' })
  } finally {
    await h.cleanup()
  }
})
