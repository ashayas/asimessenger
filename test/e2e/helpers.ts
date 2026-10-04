import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export interface Harness {
  app: ElectronApplication
  win: Page
  userData: string
  restart(): Promise<void>
  cleanup(): Promise<void>
}

/** Launch the built app with an isolated profile. Pass seed:true to keep the first-run defaults. */
export async function launchApp(opts: { seed?: boolean; toasts?: boolean; onboarding?: boolean; userData?: string; env?: Record<string, string> } = {}): Promise<Harness> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'asi-e2e-'))
  const env = { ...process.env, ASI_USER_DATA: userData, ...(opts.seed ? {} : { ASI_NO_SEED: '1' }), ...(opts.toasts ? {} : { ASI_NO_TOAST: '1' }), ASI_NO_AUTOCLOSE: '1', ...(opts.onboarding ? {} : { ASI_SKIP_ONBOARDING: '1' }), ...opts.env } as Record<string, string>
  const h: Harness = {
    app: await electron.launch({ args: ['.'], env }),
    win: undefined as unknown as Page,
    userData,
    async restart() {
      await h.app.close()
      h.app = await electron.launch({ args: ['.'], env })
      h.win = await h.app.firstWindow()
      await h.win.getByTestId('contacts').waitFor()
    },
    async cleanup() {
      await h.app.close().catch(() => {})
      rmSync(userData, { recursive: true, force: true })
    }
  }
  h.win = await h.app.firstWindow()
  if (!opts.onboarding) await h.win.getByTestId('contacts').waitFor() // the UI (and its key handlers) are up
  return h
}
