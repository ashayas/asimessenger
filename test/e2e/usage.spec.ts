import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

const FUTURE = Math.floor(Date.now() / 1000) + 3 * 3600
const WEEK = Math.floor(Date.now() / 1000) + 3 * 86400

test('usage is always visible on the buddy list, and the Usage window shows plan limits and spend', async () => {
  const h = await launchApp({ seed: true })
  try {
    const chatId = await h.win.evaluate(async ([f5, wk]) => {
      const api = window.asi.api
      const ws = (await api.workspaces.list())[0]!
      const claude = await api.friends.create({ harness: 'fake', displayName: 'Claude Code' })
      const codex = await api.friends.create({ harness: 'fake', displayName: 'Codex' })
      const c = await api.chats.create({ workspaceId: ws.id, friendId: claude.id, title: 'auth refactor' })
      await api.usage.record({ chatId: c.id, chatTitle: 'auth refactor', friendId: claude.id, friendName: 'Claude Code', workspaceId: ws.id, workspaceName: ws.name, inputTokens: 1200, outputTokens: 800, cacheReadTokens: 480_000, costUsd: 1.25 })
      await api.usage.record({ chatId: 'gone', chatTitle: 'build fix', friendId: codex.id, friendName: 'Codex', workspaceId: ws.id, workspaceName: ws.name, inputTokens: 90_000, outputTokens: 4_000, costUsd: null })
      await api.settings.set('limits:claude', { provider: 'claude', plan: null, status: 'allowed', note: null, asOf: Date.now() - 4 * 60_000, windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 34, resetsAt: f5 }, { id: 'seven_day', label: 'Weekly', usedPercent: 91, resetsAt: wk }] })
      await api.settings.set('limits:codex', { provider: 'codex', plan: 'plus', status: 'allowed', note: '25 credits', asOf: Date.now() - 60_000, windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 2, resetsAt: f5 }, { id: 'seven_day', label: 'Weekly', usedPercent: 19, resetsAt: wk }] })
      await api.settings.set('account:codex', { lifetimeTokens: 761_086_938, peakDailyTokens: 164_959_675, asOf: Date.now(), last14: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, tokens: i * 1_000_000 })) })
      return c.id
    }, [FUTURE, WEEK])

    // the strip: both agents' windows and today's spend, without opening anything
    const strip = h.win.getByTestId('usage-strip')
    await expect(strip.locator('[data-provider="claude"] [data-window="five_hour"]')).toHaveAttribute('data-percent', '34')
    await expect(strip.locator('[data-provider="claude"] [data-window="seven_day"]')).toHaveAttribute('data-percent', '91')
    await expect(strip.locator('[data-provider="codex"] [data-window="five_hour"]')).toHaveAttribute('data-percent', '2')
    await expect(strip.locator('[data-provider="claude"] .meter.hot')).toHaveCount(1) // 91% reads as hot
    await expect(h.win.getByTestId('usage-today')).toContainText('576k tokens') // 1.2k+0.8k+480k+90k+4k, all counted
    await expect(h.win.getByTestId('usage-today')).toContainText('$1.25+') // cost only from the call that reported one, marked as partial
    await h.win.screenshot({ path: 'test-results/usage-strip.png' })

    // the full window
    const opened = h.app.waitForEvent('window')
    await strip.click()
    const w = await opened
    const win = w.getByTestId('usage-window')
    await expect(win).toBeVisible()
    await expect(win.locator('[data-provider="claude"]').first()).toContainText('Claude Code')
    await expect(win.locator('section[data-provider="codex"]')).toContainText('plus')
    await expect(win.locator('section[data-provider="codex"]')).toContainText('25 credits')
    await expect(win.locator('section[data-provider="claude"] [data-window="seven_day"]')).toContainText('91%')
    await expect(win.locator('section[data-provider="claude"]')).toContainText('as of 4m ago')
    await expect(win.getByTestId('total-Today')).toContainText('576k')
    await expect(win.getByTestId('total-All time')).toContainText('tokens')
    // by agent: Claude Code reports a cost, Codex does not and is not shown as free
    const rows = win.locator('table').first().locator('tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'Codex' })).toContainText('not reported')
    await expect(rows.filter({ hasText: 'Claude Code' })).toContainText('$1.25')
    await expect(win).toContainText('Codex account, all clients')
    await expect(win).toContainText('761M')
    await w.screenshot({ path: 'test-results/usage-window.png' })

    // a window whose reset time has passed no longer claims its old number
    await h.win.evaluate(async () => { await window.asi.api.settings.set('limits:claude', { provider: 'claude', plan: null, status: 'allowed', note: null, asOf: Date.now() - 6 * 3600_000, windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 88, resetsAt: Math.floor(Date.now() / 1000) - 60 }] }); window.dispatchEvent(new Event('focus')) })
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.webContents.send('asi:changed', 'usage')))
    await expect(strip.locator('[data-provider="claude"] [data-window="five_hour"]')).toHaveAttribute('data-percent', 'reset')

    // forgetting spend keeps the plan limits
    await w.getByRole('button', { name: /Forget recorded spend/ }).click()
    await w.getByRole('button', { name: 'Forget spend', exact: true }).click()
    await expect(w.getByTestId('total-All time')).toContainText('0')
    await expect(strip.locator('[data-provider="codex"]')).toBeVisible()

    // per chat: spend appears in that chat's header
    await h.win.evaluate((id) => window.asi.api.usage.record({ chatId: id, chatTitle: 'auth refactor', inputTokens: 2000, outputTokens: 1000, costUsd: 0.5 }), chatId)
    const chatWin = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await chatWin
    await expect(chat.getByTestId('chat-usage')).toContainText('3k tokens · $0.50')
  } finally {
    await h.cleanup()
  }
})
