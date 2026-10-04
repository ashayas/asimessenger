import { useState } from 'react'
import { avatarFor } from '@shared/harness-meta'
import { Avatar, Btn, WindowFrame } from './ui/kit'
import { useData } from './store'
import { useSetting } from './hooks'
import { VoiceSettings } from './VoiceSettings'

export function Options() {
  const friends = useData((s) => s.friends).filter((f) => f.harness !== 'asi' && f.harness !== 'echo' && f.harness !== 'fake')
  const [global, ready] = useSetting<boolean>('allowDangerous', false)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')

  return (
    <WindowFrame title="Options">
      <div className="opts">
        <section>
          <h3>Safety</h3>
          <p className="hint">Every friend starts in <b>Ask</b> mode. Dangerous mode lets an agent run commands and edit files with no prompts, so it needs two switches: this global one and one for each friend.</p>
          <label className="check">
            <input
              type="checkbox"
              aria-label="Allow dangerous modes"
              checked={global}
              disabled={!ready}
              onChange={(e) => {
                if (e.target.checked) setConfirming(true)
                else void window.asi.safety.setGlobalDangerous(false)
              }}
            />
            Allow dangerous modes
          </label>
          {confirming && !global ? (
            <div className="note" role="alert">
              <div>Type <b>DANGEROUS</b> to turn this on.</div>
              <div className="row">
                <input className="field" aria-label="Type DANGEROUS to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
                <Btn kind="danger" disabled={typed !== 'DANGEROUS'} onClick={() => { void window.asi.safety.setGlobalDangerous(true); setConfirming(false); setTyped('') }}>Turn on</Btn>
                <Btn onClick={() => { setConfirming(false); setTyped('') }}>Cancel</Btn>
              </div>
            </div>
          ) : null}
          <div className="friend-opts" data-testid="friend-opts">
            {friends.length === 0 && <div className="empty">Add a friend to choose who may use dangerous mode.</div>}
            {friends.map((f) => {
              const a = avatarFor(f)
              return (
                <label key={f.id} className="friend-opt" data-friend={f.displayName}>
                  <Avatar label={a.label} gradient={a.gradient} presence="online" size="sm" />
                  <span className="grow">{f.displayName}</span>
                  <input type="checkbox" aria-label={`Allow dangerous mode for ${f.displayName}`} checked={f.dangerousAllowed} disabled={!global} onChange={(e) => void window.asi.safety.setFriendDangerous(f.id, e.target.checked)} />
                </label>
              )
            })}
          </div>
          {!global && friends.length > 0 ? <div className="hint">Per-friend switches unlock once the global switch is on.</div> : null}
        </section>
        <VoiceSettings />
      </div>
    </WindowFrame>
  )
}
