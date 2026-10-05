import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('close a workspace: its tab goes and its agents stop, chats are kept; reopen it from the closed list or by adding the folder again; delete for good', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'asi-e2e-wsclose-')))
  const honey = join(root, 'honeycomb'); mkdirSync(honey)
  const fantasy = join(root, 'fantasy'); mkdirSync(fantasy)
  const h = await launchApp({ env: { ASI_TEST_FOLDER: honey } })
  try {
    await h.win.evaluate(async ([a, b]) => {
      const api = window.asi.api
      const w1 = await api.workspaces.create({ name: 'honeycomb', path: a! })
      const w2 = await api.workspaces.create({ name: 'fantasy', path: b! })
      const f = await api.friends.create({ harness: 'fake', displayName: 'Fake' })
      const c1 = await api.chats.create({ workspaceId: w1.id, friendId: f.id, title: 'auth refactor' })
      await api.chats.create({ workspaceId: w2.id, friendId: f.id, title: 'chapter 3' })
      await api.chats.setStatus(c1.id, 'busy', 'running tests')
    }, [honey, fantasy])
    const tab = (n: string) => h.win.getByRole('tab', { name: new RegExp(n) })
    await expect(tab('honeycomb')).toBeVisible()
    await tab('honeycomb').click()

    // a workspace with an agent working asks first; Cancel changes nothing
    await h.win.getByRole('button', { name: 'Close workspace honeycomb' }).click()
    await expect(h.win.getByTestId('close-confirm')).toContainText('1 agent is working in honeycomb')
    await h.win.getByTestId('close-confirm').getByRole('button', { name: 'Cancel' }).click()
    await expect(tab('honeycomb')).toBeVisible()

    // confirming closes it, moves to the next workspace, and keeps the chat
    await h.win.getByRole('button', { name: 'Close workspace honeycomb' }).click()
    await h.win.getByTestId('close-confirm').getByRole('button', { name: 'Close and stop' }).click()
    await expect(tab('honeycomb')).toHaveCount(0)
    await expect(tab('fantasy')).toHaveAttribute('aria-selected', 'true')
    const closedBtn = h.win.getByRole('button', { name: 'Closed workspaces' })
    await expect(closedBtn).toContainText('1')
    await h.win.screenshot({ path: 'test-results/workspace-closed.png' })

    // reopen from the closed list: the tab, the slot and the chat are back, and nothing was left "busy"
    await closedBtn.click()
    await expect(h.win.getByTestId('closed-workspaces')).toContainText('honeycomb')
    await h.win.getByTestId('closed-workspaces').getByRole('button', { name: 'Reopen' }).click()
    await expect(tab('honeycomb')).toHaveAttribute('aria-selected', 'true')
    await expect(tab('honeycomb')).toContainText('⌘1')
    await h.win.getByRole('tab', { name: /^Chats/ }).click()
    await expect(h.win.locator('[data-chat="auth refactor"]')).toHaveAttribute('data-presence', 'online')

    // a workspace with nothing running closes at once, no question asked
    await h.win.getByRole('button', { name: 'Close workspace fantasy' }).click()
    await expect(tab('fantasy')).toHaveCount(0)
    await expect(h.win.getByTestId('close-confirm')).toHaveCount(0)

    // adding the same folder again brings the closed workspace back instead of making a duplicate
    await h.win.getByRole('button', { name: 'Close workspace honeycomb' }).click()
    await expect(tab('honeycomb')).toHaveCount(0)
    await h.win.getByRole('button', { name: 'Add workspace' }).click() // picks `honeycomb` (the test folder)
    await expect(tab('honeycomb')).toHaveCount(1)
    await h.win.getByRole('tab', { name: /^Chats/ }).click()
    await expect(h.win.locator('[data-chat="auth refactor"]')).toBeVisible() // its history came with it

    // deleting a closed workspace removes it and its chats for good
    await h.win.getByRole('button', { name: 'Closed workspaces' }).click()
    await h.win.getByTestId('closed-workspaces').getByRole('button', { name: 'Delete…' }).click()
    await expect(h.win.getByTestId('closed-workspaces')).toContainText('Delete it and all its chats?')
    await h.win.getByTestId('closed-workspaces').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(h.win.getByRole('button', { name: 'Closed workspaces' })).toHaveCount(0)
    const left = await h.win.evaluate(async () => ({ w: (await window.asi.api.workspaces.list()).map((x) => x.name), listClosed: (await window.asi.api.workspaces.listClosed()).length, chats: (await window.asi.api.chats.list()).map((c) => c.title) }))
    expect(left).toEqual({ w: ['honeycomb'], listClosed: 0, chats: ['auth refactor'] })
  } finally {
    await h.cleanup()
  }
})
