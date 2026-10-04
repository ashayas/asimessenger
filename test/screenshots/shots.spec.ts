import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { launchApp } from '../e2e/helpers'

const OUT = 'docs/images'
const size = (h: { app: import('@playwright/test').ElectronApplication }, match: string, w: number, ht: number, x = 380, y = 60) =>
  h.app.evaluate(({ BrowserWindow }, [m, w2, h2, x2, y2]) => { BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes(m as string))?.setBounds({ x: x2 as number, y: y2 as number, width: w2 as number, height: h2 as number }) }, [match, w, ht, x, y] as const)
const shot = async (p: Page, name: string) => { await p.waitForTimeout(400); await p.screenshot({ path: join(OUT, name) }) }

test('capture the README screenshots from a demo scene', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'asi-demo-bin-'))
  for (const [c, v] of [['claude', '2.1.289 (Claude Code)'], ['codex', 'codex-cli 0.160.0'], ['opencode', '1.18.30']]) { writeFileSync(join(bin, c!), `#!/bin/sh\necho "${v}"\n`); chmodSync(join(bin, c!), 0o755) }
  const ws = mkdtempSync(join(tmpdir(), 'honeycomb-'))
  mkdirSync(ws, { recursive: true })
  const h = await launchApp({ seed: true, toasts: true, env: { ASI_TEST_PATH: `${bin}:/usr/bin:/bin`, ASI_VOICE_FAKE: 'x' } })
  try {
    const ids = await h.win.evaluate(async (path) => {
      const api = window.asi.api
      await api.settings.set('profile', { name: 'Ashaya', personalMessage: '<shipping asi messenger>', presence: 'online' })
      const home = (await api.workspaces.list())[0]!
      await api.workspaces.setPath(home.id, path); await api.workspaces.rename(home.id, 'honeycomb')
      const w2 = await api.workspaces.create({ name: 'fantasy', path: '/tmp/fantasy' })
      await api.workspaces.create({ name: 'ghostty+', path: '/tmp/ghostty' })
      void w2
      const mk = (harness: 'claude' | 'codex' | 'acp', displayName: string, avatar: string, extra: Record<string, unknown> = {}) => api.friends.create({ harness, displayName, avatar, command: avatar, ...extra })
      const claude = await mk('claude', 'Claude Code', 'claude')
      const codex = await mk('codex', 'Codex', 'codex')
      const oc = await mk('acp', 'OpenCode', 'opencode', { transport: 'opencode' })
      await api.friends.create({ harness: 'acp', displayName: 'Gemini CLI', avatar: 'gemini', command: 'gemini', transport: 'gemini' })
      await api.friends.create({ harness: 'acp', displayName: 'Pi', avatar: 'pi', command: 'pi-acp', transport: 'generic' })
      const c1 = await api.chats.create({ workspaceId: home.id, friendId: claude.id, title: 'auth refactor' })
      const c2 = await api.chats.create({ workspaceId: home.id, friendId: codex.id, title: 'build fix' })
      const c3 = await api.chats.create({ workspaceId: home.id, friendId: oc.id, title: 'api routes' })
      await api.chats.setStatus(c1.id, 'busy', '✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧ session.test.ts')
      await api.chats.setStatus(c2.id, 'away', '(⊙_⊙) waiting on u: rm -rf dist')
      await api.chats.setStatus(c3.id, 'busy', '~*~ editing api/routes.ts ~*~')
      const lab = await api.labels.create('infra', '#6b3fa0'); await api.labels.setForChat(c1.id, [lab.id])
      const ap = (chatId: string, role: 'user' | 'agent', kind: string, body: unknown, text: string) => api.messages.append({ chatId, role, kind, body, text })
      await ap(c1.id, 'user', 'text', { text: 'the session refresh test is flaky. find out why and fix it' }, 'the session refresh test is flaky. find out why and fix it')
      await ap(c1.id, 'agent', 'text', { text: 'Reproducing first, then I will look at the refresh path.' }, 'Reproducing first, then I will look at the refresh path.')
      await ap(c1.id, 'agent', 'tool', { t: 'tool', id: 't1', kind: 'exec', title: 'Run tests', command: 'pnpm vitest run src/auth/session.test.ts', output: '✗ refreshes once under concurrent calls\n  expected 1, got 2\n  1 failed | 23 passed', exit: 1, durationMs: 2400, done: true }, 'pnpm vitest run')
      await ap(c1.id, 'agent', 'attachment', { t: 'attachment', id: 'a1', kind: 'markdown', name: 'refresh-race.md', body: '# Root cause\n\nTwo tabs call `refresh()` at once; the lock is per tab, so both win.\n\n```ts\nawait navigator.locks.request("refresh", () => doRefresh())\n```\n\n- Use a **global** lock (BroadcastChannel)\n- Add a regression test\n' }, 'refresh-race.md')
      await ap(c1.id, 'agent', 'permission', { t: 'permission', reqId: 'p1', tool: 'Edit', summary: 'src/auth/session.ts', risk: 'low', options: [{ id: 'allow-once', label: 'Allow once' }, { id: 'allow-chat', label: 'Allow for this chat' }, { id: 'deny', label: 'Deny' }], decision: null }, 'Edit src/auth/session.ts')
      await ap(c1.id, 'agent', 'question', { t: 'question', reqId: 'q1', prompt: 'Should the refresh lock be per tab or global (BroadcastChannel)?', choices: ['Per tab', 'Global'], answer: null }, 'lock question')
      const ev = await api.messages.list(c1.id)
      await api.chats.markRead(c1.id)
      return { c1: c1.id, c2: c2.id, att: ev.find((m) => m.kind === 'attachment')!.id, ws: home.id, claude: claude.id }
    }, ws)
    await expect(h.win.locator('[data-friend="Claude Code"]')).toBeVisible()
    await size(h, '#/contacts', 330, 760, 40, 50)
    await h.win.waitForTimeout(600)
    await shot(h.win, 'contacts.png')

    // conversation
    let p = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), ids.c1)
    const chat = await p
    await expect(chat.getByTestId('transcript')).toBeVisible()
    await size(h, '#/chat/', 760, 780, 400, 40)
    await shot(chat, 'chat.png')

    // attachment viewer
    p = h.app.waitForEvent('window')
    await chat.locator('[data-kind="attachment"]').getByRole('button', { name: 'Open' }).click()
    const viewer = await p
    await size(h, '#/attachment/', 720, 560, 460, 90)
    await viewer.getByText('Two tabs call').selectText()
    await shot(viewer, 'attachment.png')

    // ⌘K
    p = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+k')
    const pal = await p
    await pal.getByLabel('Search').fill('refresh')
    await expect(pal.locator('[data-kind]').first()).toBeVisible()
    await shot(pal, 'search.png')
    await pal.getByLabel('Search').press('Escape').catch(() => {})
    await pal.close().catch(() => {})

    // doodle
    p = h.app.waitForEvent('window')
    await chat.getByRole('button', { name: 'Doodle' }).click()
    const dd = await p
    await dd.locator('canvas.interactive').waitFor({ timeout: 30_000 })
    await size(h, '#/doodle/', 960, 640, 420, 80)
    const box = (await dd.locator('canvas.interactive').boundingBox())!
    const draw = async (tool: string, x1: number, y1: number, x2: number, y2: number) => { await dd.getByTestId(`toolbar-${tool}`).click({ force: true }); await dd.mouse.move(box.x + x1, box.y + y1); await dd.mouse.down(); await dd.mouse.move(box.x + x2, box.y + y2, { steps: 6 }); await dd.mouse.up() }
    await draw('rectangle', 150, 200, 330, 290); await draw('rectangle', 520, 200, 700, 290); await draw('arrow', 335, 245, 515, 245)
    await dd.waitForTimeout(1200)
    await shot(dd, 'doodle.png')

    // ASI
    const asiChat = await h.win.evaluate(async () => { const f = (await window.asi.api.friends.list()).find((x) => x.harness === 'asi')!; const ws = (await window.asi.api.workspaces.list())[0]!; return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id, title: 'ASI' })).id })
    p = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), asiChat)
    const asi = await p
    await expect(asi.getByTestId('transcript')).toBeVisible()
    await asi.getByLabel('Message').fill('who needs me?'); await asi.getByLabel('Message').press('Enter')
    await expect(asi.getByText(/needs? you/).first()).toBeVisible()
    await size(h, `#/chat/${asiChat}`, 700, 520, 440, 120)
    await shot(asi, 'asi.png')

    // toast: an agent needs you while another window is focused
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('#/contacts'))?.focus())
    const toastP = h.app.waitForEvent('window')
    await h.win.evaluate(async (id) => { await window.asi.api.messages.append({ chatId: id, role: 'agent', kind: 'text', body: {}, text: 'Tests pass. Want me to open the PR?' }) }, ids.c2)
    await h.app.evaluate(() => import('electron').then(() => 0)).catch(() => 0)
    void toastP

    // options + welcome
    p = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+,')
    const opts = await p
    await size(h, '#/options', 620, 860, 440, 20)
    await shot(opts, 'options.png')
  } finally {
    await h.cleanup()
  }
})

test('welcome and tabs screens', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'asi-demo-bin-'))
  for (const [c, v] of [['claude', '2.1.289 (Claude Code)'], ['codex', 'codex-cli 0.160.0'], ['opencode', '1.18.30'], ['gemini', '0.29.7']]) { writeFileSync(join(bin, c!), `#!/bin/sh\necho "${v}"\n`); chmodSync(join(bin, c!), 0o755) }
  const h = await launchApp({ onboarding: true, seed: true, env: { ASI_TEST_PATH: `${bin}:/usr/bin:/bin` } })
  try {
    await expect(h.win.getByRole('heading', { name: 'ASI Messenger' })).toBeVisible()
    await h.win.getByLabel('Your name').fill('Ashaya')
    await size(h, '#/welcome', 460, 760, 500, 40)
    await shot(h.win, 'welcome.png')
  } finally {
    await h.cleanup()
  }
})

test('hero banner', async () => {
  const { writeFileSync } = await import('node:fs')
  const h = await launchApp()
  try {
    const png = await h.app.evaluate(async ({ BrowserWindow }, file) => {
      const w = new BrowserWindow({ width: 1600, height: 760, show: false, webPreferences: { offscreen: false } })
      await w.loadFile(file)
      await new Promise((r) => setTimeout(r, 800))
      const img = await w.webContents.capturePage()
      w.destroy()
      return img.resize({ width: 1600 }).toPNG().toString('base64')
    }, join(process.cwd(), 'docs/src/hero.html'))
    writeFileSync(join(OUT, 'hero.png'), Buffer.from(png, 'base64'))
  } finally {
    await h.cleanup()
  }
})
