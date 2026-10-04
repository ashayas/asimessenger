import { useEffect, useState } from 'react'
import type { DetectedPreset } from '@shared/presets'
import { avatarFor } from '@shared/harness-meta'
import { Avatar, Btn, WindowFrame } from './ui/kit'
import { useData } from './store'
import { BrainSetup } from './BrainSetup'

export function AddFriend() {
  const friends = useData((s) => s.friends)
  const [found, setFound] = useState<DetectedPreset[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [cmdline, setCmdline] = useState('')
  const [kind, setKind] = useState<'acp' | 'pty'>('acp')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { void window.asi.friends.detect().then(setFound) }, [])

  const added = (id: string) => friends.some((f) => f.avatar === id)
  const parse = () => {
    const parts = cmdline.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, '')) ?? []
    return { command: parts[0] ?? '', args: parts.slice(1) }
  }

  const addPreset = async (id: string) => {
    setBusy(id)
    try { await window.asi.friends.addPreset(id) } finally { setBusy(null) }
  }

  const test = async () => {
    const { command, args } = parse()
    if (!command) return setMsg({ ok: false, text: 'Enter the command to run.' })
    if (kind === 'pty') return setMsg({ ok: true, text: 'Raw terminal friends run any command; no handshake to test.' })
    setMsg({ ok: true, text: 'Testing…' })
    const r = await window.asi.friends.testAcp(command, args)
    setMsg(r.ok ? { ok: true, text: `Connected to ${r.agent}.` } : { ok: false, text: r.error })
  }

  const addCustom = async () => {
    const { command, args } = parse()
    try {
      await window.asi.friends.addCustom({ name, command, args, kind })
      setName(''); setCmdline(''); setMsg({ ok: true, text: 'Added.' })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err) })
    }
  }

  return (
    <WindowFrame title="Add a Friend">
      <div className="add-intro">Adding a friend registers a coding agent CLI. I looked for these on your PATH:</div>
      <div className="add-list" data-testid="add-list">
        {found === null && <div className="empty">Looking…</div>}
        {found?.map(({ preset, path, version }) => {
          const a = avatarFor({ avatar: preset.id, harness: preset.harness, displayName: preset.name })
          return (
            <div key={preset.id} className="add-row" data-preset={preset.id} data-found={path ? 'yes' : 'no'}>
              <Avatar label={a.label} gradient={a.gradient} presence={path ? 'online' : 'offline'} size="sm" />
              <div className="grow">
                <b>{preset.name}</b>
                <div className="meta">{path ? `${path} · ${version ?? 'version unknown'} · ${preset.blurb}` : `not found · ${preset.installHint}`}</div>
              </div>
              {added(preset.id) ? <span className="chip">✔ Added</span> : <Btn kind="primary" disabled={!path || busy === preset.id} onClick={() => void addPreset(preset.id)}>Add</Btn>}
            </div>
          )
        })}
      </div>
      <BrainSetup />
      <div className="byo">
        <b>Bring your own harness</b>
        <input className="field" aria-label="Friend name" placeholder="Name, e.g. My Agent" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field mono" aria-label="Command" placeholder="my-agent acp --model local" value={cmdline} onChange={(e) => setCmdline(e.target.value)} />
        <div className="row">
          <label><input type="radio" name="kind" checked={kind === 'acp'} onChange={() => setKind('acp')} /> ACP</label>
          <label><input type="radio" name="kind" checked={kind === 'pty'} onChange={() => setKind('pty')} /> Raw terminal</label>
          <span className="grow" />
          <Btn onClick={() => void test()}>Test connection</Btn>
          <Btn kind="primary" onClick={() => void addCustom()}>Add</Btn>
        </div>
        {msg ? <div className={msg.ok ? 'note ok' : 'note bad'} role="status">{msg.text}</div> : null}
      </div>
    </WindowFrame>
  )
}
