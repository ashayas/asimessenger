import { useCallback, useEffect, useState } from 'react'
import { BRAIN_PRESETS, type BrainInput, type BrainStatus } from '@shared/brain'
import { Avatar, Btn } from './ui/kit'

/** "Add ASI's brain": a decision model for risk labels and "which chat?". Clef, Jev, or any OpenAI-compatible model. Optional. */
export function BrainSetup() {
  const [st, setSt] = useState<BrainStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [presetId, setPresetId] = useState('clef')
  const [accountId, setAccountId] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState('clef-flash')
  const [baseUrl, setBaseUrl] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => setSt(await window.asi.brain.status()), [])
  useEffect(() => { void load() }, [load])

  const preset = BRAIN_PRESETS.find((p) => p.id === presetId)!
  const pick = (id: string) => {
    const p = BRAIN_PRESETS.find((x) => x.id === id)!
    setPresetId(id); setMsg(null)
    setModel(p.model ?? ''); setBaseUrl(p.baseUrl ?? '')
  }

  const connect = async () => {
    setBusy(true); setMsg(null)
    try {
      const input: BrainInput = preset.provider === 'clef' ? { accountId, token, model: model as 'clef' | 'clef-flash' } : { provider: preset.provider, baseUrl, model, token }
      const r = await window.asi.brain.connect(input)
      setMsg({ ok: true, text: `Connected. ${r.latencyMs} ms per decision${r.costPerDecisionUsd === null ? '' : `, about $${r.costPerDecisionUsd.toFixed(6)} each`}.` })
      setToken(''); setOpen(false)
      await load()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e) })
    } finally { setBusy(false) }
  }

  const label = st?.provider === 'clef' ? 'Cloudflare Clef' : st?.provider === 'systemone' ? 'Jev' : st?.provider === 'llm' ? 'chat model' : ''
  return (
    <div className="brain" data-testid="brain">
      <div className="row">
        <Avatar label="✦" gradient={['#1a43b8', '#4f9ee8']} presence={st?.connected ? 'online' : 'offline'} size="sm" />
        <div className="grow">
          <b>ASI brain</b>
          <div className="meta">{st?.connected ? `Connected · ${st.model} · ${label} ${st.accountId ? `account ${st.accountId}` : st.host}. Risk labels and “which chat?” answers use it.` : 'Optional. Connect Clef, Jev or any model. Without one ASI uses built-in rules for risk and search.'}</div>
        </div>
        {st?.connected ? <Btn onClick={() => void window.asi.brain.disconnect().then(load)}>Disconnect</Btn> : <Btn onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Set up…'}</Btn>}
      </div>
      {open ? (
        <>
          <select aria-label="Decision model" value={presetId} onChange={(e) => pick(e.target.value)}>
            {BRAIN_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <div className="meta">{preset.hint}</div>
          {preset.provider === 'clef' ? (
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
            </>
          ) : (
            <>
              <input className="field mono" aria-label="Endpoint" placeholder="https://… (http only for a server on this Mac)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <input className="field mono" aria-label="Model name" placeholder="Model name" value={model} onChange={(e) => setModel(e.target.value)} />
              <input className="field mono" type="password" aria-label="API key" placeholder={preset.needsKey ? 'API key' : 'API key (leave empty for a local server)'} value={token} onChange={(e) => setToken(e.target.value)} />
              <div className="row">
                <span className="grow" />
                <Btn kind="primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Testing…' : 'Test & save'}</Btn>
              </div>
            </>
          )}
          <div className="meta">The key is stored in your macOS keychain, never in the database. Decisions send only short descriptions of the action being judged.</div>
        </>
      ) : null}
      {msg ? <div className={msg.ok ? 'note ok' : 'note bad'} role="status">{msg.text}</div> : null}
    </div>
  )
}
