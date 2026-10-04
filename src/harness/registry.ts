import { acpFactory } from './acp/factory'
import { GENERIC_ACP, GEMINI, HERMES, OPENCODE } from './acp/presets'
import { EchoAgent } from './echo-agent'
import { FakeAgent } from './fake-agent'
import type { HarnessManager } from './manager'

const ACP_PRESETS = { opencode: OPENCODE, gemini: GEMINI, hermes: HERMES, generic: GENERIC_ACP } as const

/** Wires every built-in harness kind into the manager. ACP friends pick a preset by `transport`. */
export function registerHarnesses(manager: HarnessManager): void {
  manager.register('echo', async () => new EchoAgent())
  manager.register('fake', async () => new FakeAgent())
  manager.register('acp', (ctx) => {
    const preset = ACP_PRESETS[(ctx.friend.transport ?? 'generic') as keyof typeof ACP_PRESETS] ?? GENERIC_ACP
    return acpFactory(preset)(ctx)
  })
}
