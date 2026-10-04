import type { AgentEvent } from '@shared/events'

/** Small base for sessions: listener fan-out + a `closed` guard. */
export class EventHub {
  private listeners = new Set<(e: AgentEvent) => void>()
  closed = false

  subscribe = (l: (e: AgentEvent) => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  emit(e: AgentEvent): void {
    if (this.closed) return
    for (const l of [...this.listeners]) {
      try {
        l(e)
      } catch (err) {
        console.error('[harness] listener failed', err)
      }
    }
  }
}
