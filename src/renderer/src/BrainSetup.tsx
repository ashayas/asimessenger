import { useCallback, useEffect, useState } from 'react'
import { Avatar, Btn } from './ui/kit'

/** "Add ASI's brain": connect Cloudflare Clef so ASI can score risk and route questions. Optional; ASI works without it. */
export function BrainSetup() {
  const [st, setSt] = useState<{ connected: boolean; model?: string; accountId?: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState('clef-flash')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => setSt(await window.asi.brain.status()), [])
  useEffect(() => { void load() }, [load])

  const connect = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await window.asi.brain.connect({ accountId, token, model })
      setMsg({ ok: true, text: `Connected. ${r.latencyMs} ms per decision, about $${r.costPerDecisionUsd.toFixed(6)} each.` })
      setToken(''); setOpen(false)
      await load()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e) })
    } finally { setBusy(false) }
  }

  return (
    <div className="brain" data-testid="brain">
      <div className="row">
        <Avatar label="✦" gradient={['#1a43b8', '#4f9ee8']} presence={st?.connected ? 'online' : 'offline'} size="sm" />
        <div className="grow">
          <b>ASI brain (Cloudflare Clef)</b>
          <div className="meta">{st?.connected ? `Connected · ${st.model} · account ${st.accountId}. Risk labels and “which chat?” answers use it.` : 'Optional. Without it ASI uses built-in rules for risk and search.'}</div>
        </div>
        {st?.connected ? <Btn onClick={() => void window.asi.brain.disconnect().then(load)}>Disconnect</Btn> : <Btn onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Set up…'}</Btn>}
      </div>
      {open ? (
        <>
          <input className="field mono" aria-label="Cloudflare account ID" placeholder="Account ID (32 characters)" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
          <input className="field mono" type="password" aria-label="Workers AI API token" placeholder="API token with the Workers AI permission" value={token} onChange={(e) => setToken(e.target.value)} />
          <div className="row">
            <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="clef-flash">clef-flash · fastest (~40 ms)</option>
              <option value="clef">clef · most accurate (~200 ms)</option>
            </select>
            <span className="grow" />
            <Btn kind="primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Testing…' : 'Test & save'}</Btn>
          </div>
          <div className="meta">The token is stored in your macOS keychain, never in the database.</div>
        </>
      ) : null}
      {msg ? <div className={msg.ok ? 'note ok' : 'note bad'} role="status">{msg.text}</div> : null}
    </div>
  )
}
