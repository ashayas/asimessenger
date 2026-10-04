import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('UI kit gallery renders presence, avatars and toolbar', async () => {
  const h = await launchApp()
  try {
    await h.win.evaluate(() => { location.hash = '#/gallery' })
    await expect(h.win.getByTestId('gallery')).toBeVisible()
    await expect(h.win.locator('.dp.working')).toHaveCount(1)
    await expect(h.win.locator('.dp.waiting')).toHaveCount(1)
    await expect(h.win.locator('.dot[data-presence]')).toHaveCount(4)
    await expect(h.win.locator('.tool')).toHaveCount(5)
    await h.win.screenshot({ path: 'test-results/gallery.png' })
  } finally {
    await h.cleanup()
  }
})
