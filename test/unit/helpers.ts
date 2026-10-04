import type { AgentEvent, AgentSession } from '../../src/shared/events'

export function collect(session: AgentSession) {
  const events: AgentEvent[] = []
  session.subscribe((e) => events.push(e))
  const until = async (pred: (e: AgentEvent) => boolean, ms = 8000): Promise<AgentEvent> => {
    const t = Date.now()
    for (;;) {
      const hit = events.find(pred)
      if (hit) return hit
      if (Date.now() - t > ms) throw new Error(`timed out; saw: ${JSON.stringify(events.map((e) => e.t))}`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  return { events, until, turnEnd: () => until((e) => e.t === 'turn_end') }
}

export const friendFor = (over: Record<string, unknown> = {}) => ({
  id: 'f', harness: 'acp' as const, displayName: 'Mock', avatar: null, command: null, args: [], transport: null,
  defaultMode: 'ask' as const, dangerousAllowed: false, letteringStyle: 'funky', secretRef: null, createdAt: 0, ...over
})
