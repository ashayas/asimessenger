import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('ASI is always online, summarizes your agents, finds chats, and brings an outside session in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'asi-home-'))
  const dir = join(home, '.claude/projects/-tmp-api')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ext-session-9.jsonl'), JSON.stringify({ type: 'user', cwd: '/tmp/api', sessionId: 'ext-session-9', message: { role: 'user', content: 'add pagination to the list endpoint' } }) + '\n')
  const h = await launchApp({ seed: true, env: { ASI_DISCOVERY_HOME: home } })
  try {
    await h.win.evaluate(async () => {
      const api = window.asi.api
      const ws = (await api.workspaces.list())[0]!
      const claude = await api.friends.create({ harness: 'claude', displayName: 'Claude Code', command: 'claude', avatar: 'claude' })
      const c = await api.chats.create({ workspaceId: ws.id, friendId: claude.id, title: 'auth refactor' })
      await api.messages.append({ chatId: c.id, role: 'agent', kind: 'text', body: {}, text: 'the refresh lock should be global' })
      await api.chats.setStatus(c.id, 'away', '(⊙_⊙) waiting on u: rm -rf dist')
    })
    await expect(h.win.locator('[data-group="asi"] [data-friend="ASI"]')).toHaveAttribute('data-presence', 'online')

    const opened = h.app.waitForEvent('window')
    await h.win.locator('[data-friend="ASI"]').dblclick()
    const asi = await opened
    const say = async (t: string) => { await asi.getByLabel('Message').fill(t); await asi.getByLabel('Message').press('Enter') }

    await say('who needs me?')
    await expect(asi.getByText('1 chat needs you:')).toBeVisible()
    const row = asi.locator('[data-kind="links"] [data-target="chat"]').first()
    await expect(row).toContainText('auth refactor')
    const chatP = h.app.waitForEvent('window')
    await row.getByRole('button', { name: 'Open' }).click()
    const chat = await chatP
    await expect(chat.locator('.msg').first()).toHaveText('the refresh lock should be global')

    await say('find refresh lock')
    await expect(asi.getByText('Best match: “auth refactor”')).toBeVisible()

    await say('what is running outside messenger?')
    const adopt = asi.locator('[data-target="adopt"]')
    await expect(adopt).toContainText('add pagination to the list endpoint')
    await asi.screenshot({ path: 'test-results/asi.png' })
    const adoptedP = h.app.waitForEvent('window')
    await adopt.getByRole('button', { name: 'Bring in' }).click()
    const adopted = await adoptedP
    await expect.poll(() => h.win.evaluate(async () => (await window.asi.api.chats.list()).find((c) => c.harnessSessionId === 'ext-session-9')?.title)).toBe('add pagination to the list endpoint')
    void adopted
  } finally {
    await h.cleanup()
  }
})

test('Add a friend › ASI brain: invalid credentials are rejected clearly; valid ones connect and can be disconnected', async () => {
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer ' + 'g'.repeat(40)
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(ok ? { success: true, result: { answers: { ok: { noul: 0.9 } } } } : { success: false, errors: [{ message: 'Invalid API Token' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const bin = mkdtempSync(join(tmpdir(), 'asi-bin-'))
  chmodSync(bin, 0o755)
  const h = await launchApp({ seed: true, env: { ASI_CLEF_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } })
  try {
    const opened = h.app.waitForEvent('window')
    await h.win.getByRole('button', { name: /Add a friend/ }).click()
    const add = await opened
    await expect(add.getByTestId('brain')).toContainText('Optional')
    await add.getByRole('button', { name: 'Set up…' }).click()
    await add.getByLabel('Cloudflare account ID').fill('nope')
    await add.getByLabel('Workers AI API token').fill('x'.repeat(30))
    await add.getByRole('button', { name: 'Test & save' }).click()
    await expect(add.getByRole('status')).toContainText('32 hex')

    await add.getByLabel('Cloudflare account ID').fill('b'.repeat(32))
    await add.getByLabel('Workers AI API token').fill('wrong-token-wrong-token-wrong-token')
    await add.getByRole('button', { name: 'Test & save' }).click()
    await expect(add.getByRole('status')).toContainText('Invalid API Token')
    await expect(add.getByTestId('brain')).not.toContainText('Connected')

    await add.getByLabel('Workers AI API token').fill('g'.repeat(40))
    await add.getByRole('button', { name: 'Test & save' }).click()
    await expect(add.getByTestId('brain')).toContainText('Connected · clef-flash')
    await expect(add.getByTestId('brain')).toContainText('bbbb…bbbb')
    await add.screenshot({ path: 'test-results/brain.png' })
    await add.getByRole('button', { name: 'Disconnect' }).click()
    await expect(add.getByTestId('brain')).toContainText('Optional')
  } finally {
    server.close()
    await h.cleanup()
  }
})
