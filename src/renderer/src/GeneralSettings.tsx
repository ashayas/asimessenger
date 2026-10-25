import { useState } from 'react'
import { avatarFor } from '@shared/harness-meta'
import { splitArgs } from '@shared/presets'
import { Avatar, Btn } from './ui/kit'
import { play } from './sounds'
import { useData } from './store'
import { useSetting } from './hooks'

/** Options: windows, sounds, status lettering, agent CLI arguments, your data. */
export function GeneralSettings() {
  const friends = useData((s) => s.friends)
  const cliFriends = friends.filter((f) => f.harness !== 'asi' && f.harness !== 'echo')
  const [windows] = useSetting<'windows' | 'tabs'>('chatWindows', 'windows')
  const [soundsOn] = useSetting<boolean>('soundsOn', true)
  const [volume] = useSetting<number>('soundVolume', 0.7)
  const set = (k: string, v: unknown) => void window.asi.api.settings.set(k, v)
  const [confirm, setConfirm] = useState(false)
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState<string | null>(null)

  return (
    <>
      <section data-testid="windows-settings">
        <h3>Chat windows</h3>
        <label className="check"><input type="radio" name="cw" aria-label="One window per chat" checked={windows === 'windows'} onChange={() => set('chatWindows', 'windows')} /> One window per chat (classic)</label>
        <label className="check"><input type="radio" name="cw" aria-label="Tabs per workspace" checked={windows === 'tabs'} onChange={() => set('chatWindows', 'tabs')} /> Tabs: one window per workspace</label>
      </section>

      <section data-testid="sound-settings">
        <h3>Sounds</h3>
        <label className="check"><input type="checkbox" aria-label="Play sounds" checked={soundsOn} onChange={(e) => set('soundsOn', e.target.checked)} /> Nudge, new message and sign-in sounds</label>
        <div className="row"><span>Volume</span><input type="range" aria-label="Volume" min={0} max={1} step={0.05} value={volume} disabled={!soundsOn} onChange={(e) => set('soundVolume', Number(e.target.value))} />
          <Btn disabled={!soundsOn} onClick={() => play('nudge')}>Test</Btn></div>
      </section>

      <section data-testid="lettering-settings">
        <h3>Status lettering</h3>
        <p className="hint">The line under each friend’s name, for example “✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧”. Plain keeps the same information without decoration.</p>
        <div className="friend-opts">
          {friends.map((f) => {
            const a = avatarFor(f)
            return (
              <label key={f.id} className="friend-opt" data-friend={f.displayName}>
                <Avatar label={a.label} gradient={a.gradient} presence="online" size="sm" />
                <span className="grow">{f.displayName}</span>
                <select aria-label={`Lettering for ${f.displayName}`} value={f.letteringStyle === 'plain' ? 'plain' : 'funky'} onChange={(e) => void window.asi.api.friends.setLettering(f.id, e.target.value as 'funky' | 'plain')}>
                  <option value="funky">Funky</option><option value="plain">Plain</option>
                </select>
              </label>
            )
          })}
        </div>
      </section>

      {cliFriends.length > 0 ? (
        <section data-testid="friend-args-settings">
          <h3>Agent CLI arguments</h3>
          <p className="hint">Extra CLI flags passed when launching each agent (for example <code>--model haiku</code>, <code>-c model=&quot;gpt-5.6-luna&quot;</code>, or <code>--provider openrouter --model …</code>). Changes take effect on the next turn.</p>
          <div className="friend-opts">
            {cliFriends.map((f) => {
              const a = avatarFor(f)
              return (
                <div key={f.id} className="friend-opt" data-friend-args={f.displayName}>
                  <Avatar label={a.label} gradient={a.gradient} presence="online" size="sm" />
                  <span style={{ minWidth: 96, fontWeight: 600 }}>{f.displayName}</span>
                  <input
                    key={f.args.join(' ')}
                    className="field mono grow"
                    aria-label={`Arguments for ${f.displayName}`}
                    placeholder="e.g. --model haiku"
                    defaultValue={f.args.join(' ')}
                    onBlur={(e) => void window.asi.api.friends.setArgs(f.id, splitArgs(e.currentTarget.value))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur()
                      }
                    }}
                  />
                  <Btn aria-label={`Remove ${f.displayName}`} title={`Remove ${f.displayName}`} onClick={() => void window.asi.api.friends.remove(f.id)}>Remove</Btn>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      <section data-testid="data-settings">
        <h3>Your data</h3>
        <p className="hint">Everything lives in a local database on this Mac. Export it as JSON, or delete all chats (friends and workspaces stay).</p>
        <div className="row">
          <Btn onClick={() => void window.asi.data.exportAll().then((p) => setNote(p ? `Exported to ${p}` : 'Export cancelled'))}>Export all chats…</Btn>
          <Btn kind="danger" onClick={() => setConfirm((c) => !c)}>Delete all chats…</Btn>
        </div>
        {confirm ? (
          <div className="note" role="alert">
            <div>This cannot be undone. Type <b>DELETE</b> to confirm.</div>
            <div className="row">
              <input className="field" aria-label="Type DELETE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
              <Btn kind="danger" disabled={typed !== 'DELETE'} onClick={() => void window.asi.data.deleteAllChats().then((n) => { setNote(`Deleted ${n} chat${n === 1 ? '' : 's'}`); setConfirm(false); setTyped('') })}>Delete</Btn>
            </div>
          </div>
        ) : null}
        {note ? <div className="note ok" role="status">{note}</div> : null}
      </section>
    </>
  )
}
