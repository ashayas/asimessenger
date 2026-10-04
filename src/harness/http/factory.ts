import { parseManifest } from './manifest'
import { HttpSession } from './session'
import type { HarnessFactory } from '../types'

/** HTTP friends keep their manifest as args[0] and their token in the keychain under manifest.auth.secret. */
export function httpFactory(secrets: { get(name: string): Promise<string | null> }, fetchImpl?: typeof fetch): HarnessFactory {
  return async (ctx) => {
    const manifest = parseManifest(ctx.friend.args[0] ?? '')
    const token = manifest.auth ? await secrets.get(manifest.auth.secret) : null
    if (manifest.auth && !token) throw new Error(`no token stored for ${ctx.friend.displayName}; edit the friend and enter it again`)
    return new HttpSession({ manifest, token, resumeId: ctx.resumeId, fetchImpl })
  }
}
