import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('app launches with the ASI Messenger title and contact list', async () => {
  const h = await launchApp({ seed: true })
  try {
    await expect(h.win).toHaveTitle('ASI Messenger')
    await expect(h.win.getByTestId('contacts')).toBeVisible()
    // first-run defaults: ASI is pinned and always online, Echo is the local test friend
    await expect(h.win.locator('[data-group="asi"] [data-friend="ASI"]')).toHaveAttribute('data-presence', 'online')
    await expect(h.win.locator('[data-friend="Echo"]')).toBeVisible()
  } finally {
    await h.cleanup()
  }
})
