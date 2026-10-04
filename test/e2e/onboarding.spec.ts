import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('first run shows the Sign In screen; completing it opens the contact list set up for you; it never shows again', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'asi-bin-'))
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n')
  chmodSync(join(bin, 'claude'), 0o755)
  const folder = mkdtempSync(join(tmpdir(), 'asi-honeycomb-'))
  const h = await launchApp({ onboarding: true, seed: true, env: { ASI_TEST_PATH: `${bin}:/usr/bin:/bin`, ASI_TEST_FOLDER: folder } })
  try {
    const welcome = h.win
    await expect(welcome.getByRole('heading', { name: 'ASI Messenger' })).toBeVisible()
    await expect(welcome.locator('[data-preset="claude"]')).toHaveAttribute('data-found', 'yes')
    await expect(welcome.getByLabel('Add Claude Code')).toBeChecked() // found agents are pre-selected
    await expect(welcome.getByLabel('Add Codex')).toBeDisabled() // not installed
    await welcome.screenshot({ path: 'test-results/welcome.png' })

    // a name is required
    await welcome.getByRole('button', { name: 'Sign In' }).click()
    await expect(welcome.getByRole('alert')).toContainText('call you')

    await welcome.getByLabel('Your name').fill('Ashaya')
    await welcome.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(welcome.getByLabel('Workspace folder')).toHaveValue(folder)
    const contactsP = h.app.waitForEvent('window')
    await welcome.getByRole('button', { name: 'Sign In' }).click()
    const contacts = await contactsP
    await expect(contacts.getByTestId('profile-name')).toHaveText('Ashaya')
    await expect(contacts.locator('[data-workspace]')).toHaveText(/honeycomb/)
    await expect(contacts.locator('[data-friend="Claude Code"]')).toBeVisible()

    // second launch goes straight to the contact list
    await h.restart()
    await expect(h.win.getByTestId('profile-name')).toHaveText('Ashaya')
  } finally {
    await h.cleanup()
  }
})
