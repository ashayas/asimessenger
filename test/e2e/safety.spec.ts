import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('dangerous mode: locked by default, unlocked with two switches, red title bar, relocks when revoked', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'claude', displayName: 'Claude Code', command: 'claude' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened

    const dangerous = chat.locator('[data-mode="dangerous"]')
    await expect(chat.locator('[data-mode="ask"]')).toHaveAttribute('aria-checked', 'true')
    await expect(dangerous).toContainText('locked')
    await dangerous.click()
    await expect(chat.getByRole('status')).toContainText('turned off')

    // global switch needs typed confirmation
    const optsOpened = h.app.waitForEvent('window')
    await chat.getByRole('button', { name: 'Open Options' }).click()
    const opts = await optsOpened
    await expect(opts.getByLabel('Allow dangerous mode for Claude Code')).toBeDisabled()
    await opts.getByLabel('Allow dangerous modes').click() // opens the typed confirmation; the box stays unchecked until confirmed
    await expect(opts.getByRole('button', { name: 'Turn on' })).toBeDisabled()
    await opts.getByLabel('Type DANGEROUS to confirm').fill('DANGEROUS')
    await opts.getByRole('button', { name: 'Turn on' }).click()
    await opts.getByLabel('Allow dangerous mode for Claude Code').click()
    await expect(opts.getByLabel('Allow dangerous mode for Claude Code')).toBeChecked()

    await dangerous.click()
    await expect(dangerous).toHaveAttribute('aria-checked', 'true')
    await expect(chat.locator('.titlebar.danger')).toContainText('DANGEROUS')
    await h.win.getByRole('tab', { name: 'Chats' }).click()
    await chat.screenshot({ path: 'test-results/dangerous.png' })

    // revoking the global switch drops the chat back to Ask
    await opts.getByLabel('Allow dangerous modes').click()
    await expect(chat.locator('[data-mode="ask"]')).toHaveAttribute('aria-checked', 'true')
    await expect(chat.locator('.titlebar.danger')).toHaveCount(0)
  } finally {
    await h.cleanup()
  }
})

test('Deny… asks for a reason and sends it to the agent', async () => {
  const h = await launchApp()
  try {
    const chatId = await h.win.evaluate(async () => {
      const ws = await window.asi.api.workspaces.create({ name: 'w', path: '/tmp' })
      const f = await window.asi.api.friends.create({ harness: 'fake', displayName: 'Fake' })
      return (await window.asi.api.chats.create({ workspaceId: ws.id, friendId: f.id })).id
    })
    const opened = h.app.waitForEvent('window')
    await h.win.evaluate((id) => window.asi.chat.openWindow(id), chatId)
    const chat = await opened
    await chat.getByLabel('Message').fill('/script permission')
    await chat.getByLabel('Message').press('Enter')
    await expect(chat.locator('[data-kind="permission"] .risk')).toHaveText('high risk')
    await chat.getByRole('button', { name: 'Deny…' }).click()
    await chat.getByLabel('Reason for denying').fill('too risky')
    await chat.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(chat.locator('[data-kind="permission"]')).toContainText('Denied — too risky')
  } finally {
    await h.cleanup()
  }
})
