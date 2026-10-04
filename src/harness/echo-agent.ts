import { EventHub } from './emitter'
import type { AgentSession, UserTurn } from '@shared/events'

/** The built-in Echo friend: repeats what you say. Useful as a zero-setup smoke test. */
export class EchoAgent implements AgentSession {
  private hub = new EventHub()
  subscribe = this.hub.subscribe
  readonly resumeId = undefined
  private n = 0

  send(turn: UserTurn): void {
    const id = `echo-${++this.n}`
    setTimeout(() => {
      this.hub.emit({ t: 'text', id, delta: `echo: ${turn.text}` })
      this.hub.emit({ t: 'turn_end', reason: 'done' })
    }, 150)
  }
  async interrupt(): Promise<void> {}
  respond(): void {}
  setMode(): void {}
  async dispose(): Promise<void> {
    this.hub.closed = true
  }
}
