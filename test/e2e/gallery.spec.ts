import { test, expect, _electron as electron } from '@playwright/test'

test('UI kit gallery renders presence, avatars and toolbar', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.evaluate(() => { location.hash = '#/gallery' })
  await expect(win.getByTestId('gallery')).toBeVisible()
  await expect(win.locator('.dp.working')).toHaveCount(1)
  await expect(win.locator('.dp.waiting')).toHaveCount(1)
  await expect(win.locator('.dot[data-presence]')).toHaveCount(4)
  await expect(win.locator('.tool')).toHaveCount(5)
  await win.screenshot({ path: 'test-results/gallery.png' })
  await app.close()
})
