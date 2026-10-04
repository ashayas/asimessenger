import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/** A live terminal for a raw-terminal friend. Keystrokes go straight to the pseudo-terminal. */
export function TerminalDrawer({ chatId }: { chatId: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'IBM Plex Mono, ui-monospace, Menlo, monospace', fontSize: 12, cursorBlink: true, convertEol: false,
      theme: { background: '#0f1b2e', foreground: '#d7e3f7' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    const doFit = () => { try { fit.fit(); void window.asi.pty.resize(chatId, term.cols, term.rows) } catch { /* not laid out yet */ } }
    void window.asi.pty.attach(chatId).then((buffer) => { term.write(buffer); doFit() })
    const off = window.asi.pty.onData((id, d) => { if (id === chatId) term.write(d) })
    const sub = term.onData((d) => void window.asi.pty.input(chatId, d))
    const ro = new ResizeObserver(doFit)
    ro.observe(host.current!)
    return () => { off(); sub.dispose(); ro.disconnect(); term.dispose() }
  }, [chatId])

  return <div className="term" data-testid="terminal" ref={host} />
}
