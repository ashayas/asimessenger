import { test, expect, _electron as electron } from '@playwright/test'

test('app launches with the ASI Messenger title', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await expect(win).toHaveTitle('ASI Messenger')
  await expect(win.locator('h1')).toHaveText('ASI Messenger')
  await app.close()
})
