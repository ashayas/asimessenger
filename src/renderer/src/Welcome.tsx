import { useEffect, useState } from 'react'
import type { DetectedPreset } from '@shared/presets'
import { avatarFor } from '@shared/harness-meta'
import { Avatar, Btn } from './ui/kit'
import { play } from './sounds'
import logo from '../../../assets/logo.svg?url'

/** The "Sign In" screen: everything ASI Messenger needs, set up once. */
export function Welcome() {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [found, setFound] = useState<DetectedPreset[] | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [mic, setMic] = useState('unknown')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.asi.friends.detect().then((d) => { setFound(d); setPicked(Object.fromEntries(d.filter((x) => x.path).map((x) => [x.preset.id, true]))) })
    void window.asi.onboarding.micStatus().then(setMic)
    void window.asi.api.workspaces.list().then((w) => w[0] && setFolder(w[0].path))
    void window.asi.api.settings.get<{ name: string }>('profile', { name: '' }).then((p) => setName(p.name === 'You' ? '' : p.name))
  }, [])

  const pickFolder = async () => { const p = await window.asi.pickFolder(); if (p) setFolder(p) }
  const signIn = async () => {
    setBusy(true); setErr(null)
    try {
      play('signin')
      await window.asi.onboarding.complete({ name, workspacePath: folder, presetIds: Object.keys(picked).filter((k) => picked[k]) })
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <div className="titlebar"><span className="t">Welcome to ASI Messenger</span></div>
      <div className="w-body">
        <div className="w-hero">
          <img src={logo} alt="" width={72} height={72} />
          <div>
            <h1>ASI Messenger</h1>
            <p>Your coding agents, one chat window each. Let’s get you signed in.</p>
          </div>
        </div>

        <section>
          <h3>1. Your name</h3>
          <input className="field" aria-label="Your name" placeholder="What should your agents call you?" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </section>

        <section>
          <h3>2. Your first workspace</h3>
          <div className="row">
            <input className="field mono" aria-label="Workspace folder" readOnly value={folder} />
            <Btn onClick={() => void pickFolder()}>Choose folder…</Btn>
          </div>
          <p className="hint">Chats, drawings and ⌘1 live here. Add more workspaces later (⌘2, ⌘3…).</p>
        </section>

        <section>
          <h3>3. Agents found on this Mac</h3>
          <div className="w-agents" data-testid="w-agents">
            {found === null && <div className="empty">Looking…</div>}
            {found?.map(({ preset, path, version }) => {
              const a = avatarFor({ avatar: preset.id, harness: preset.harness, displayName: preset.name })
              return (
                <label key={preset.id} className="w-agent" data-preset={preset.id} data-found={path ? 'yes' : 'no'}>
                  <input type="checkbox" aria-label={`Add ${preset.name}`} disabled={!path} checked={!!picked[preset.id]} onChange={(e) => setPicked((p) => ({ ...p, [preset.id]: e.target.checked }))} />
                  <Avatar label={a.label} gradient={a.gradient} presence={path ? 'online' : 'offline'} size="sm" />
                  <span className="grow"><b>{preset.name}</b><span className="meta">{path ? version ?? 'installed' : 'not installed'}</span></span>
                </label>
              )
            })}
          </div>
        </section>

        <section>
          <h3>4. Permissions</h3>
          <div className="w-perm">
            <span>🎙 Microphone (push-to-talk, transcribed on this Mac)</span>
            <span className="grow" />
            {mic === 'granted' ? <span className="chip">✔ Allowed</span> : <Btn onClick={() => void window.asi.onboarding.askMic().then(setMic)}>{mic === 'denied' ? 'Denied: open System Settings' : 'Allow'}</Btn>}
          </div>
          <div className="w-perm"><span>🛡 Dangerous modes</span><span className="grow" /><span className="chip">Off (recommended)</span></div>
        </section>

        {err ? <div className="note bad" role="alert">{err}</div> : null}
        <Btn kind="primary" className="wide signin" disabled={busy} onClick={() => void signIn()}>Sign In</Btn>
      </div>
    </div>
  )
}
