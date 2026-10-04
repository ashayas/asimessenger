import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('Add a Friend detects CLIs on PATH and adds them to the contact list as online', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'asi-bin-'))
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n')
  chmodSync(join(bin, 'claude'), 0o755)
  const h = await launchApp({ seed: true, env: { ASI_TEST_PATH: `${bin}:/usr/bin:/bin` } })
  try {
    const opened = h.app.waitForEvent('window')
    await h.win.getByRole('button', { name: /Add a friend/ }).click()
    const add = await opened
    await expect(add.locator('[data-preset="claude"]')).toContainText('9.9.9 (Claude Code)')
    await expect(add.locator('[data-preset="claude"]')).toHaveAttribute('data-found', 'yes')
    await expect(add.locator('[data-preset="codex"]')).toHaveAttribute('data-found', 'no')
    await expect(add.locator('[data-preset="codex"] button')).toBeDisabled()

    await add.locator('[data-preset="claude"]').getByRole('button', { name: 'Add' }).click()
    await expect(add.locator('[data-preset="claude"]')).toContainText('Added')
    await expect(h.win.locator('[data-friend="Claude Code"]')).toHaveAttribute('data-presence', 'online')

    // BYO validation message
    await add.getByRole('button', { name: 'Add', exact: true }).last().click()
    await expect(add.getByRole('status')).toContainText('name')
    await add.screenshot({ path: 'test-results/add-friend.png' })
  } finally {
    await h.cleanup()
  }
})
