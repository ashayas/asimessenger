import { useCallback, useEffect, useState } from 'react'
import { fmtBytes } from '@shared/voice-models'
import type { VoiceOverview, VoiceProgress } from './env.d'
import { Btn } from './ui/kit'

const PHASE: Record<string, string> = { runtime: 'Setting up the speech runtime', checking: 'Checking disk space', downloading: 'Downloading', verifying: 'Verifying the download', extracting: 'Unpacking', done: 'Done' }

/** Options › Voice: pick the engine, download the recommended model, see exactly what it costs in disk. */
export function VoiceSettings() {
  const [o, setO] = useState<VoiceOverview | null>(null)
  const [prog, setProg] = useState<Record<string, VoiceProgress>>({})
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => setO(await window.asi.voice.overview()), [])
  useEffect(() => {
    void load()
    const off = window.asi.voice.onProgress((p) => setProg((m) => ({ ...m, [p.modelId]: p })))
    const off2 = window.asi.onChanged((t) => { if (t === 'settings') void load() })
    return () => { off(); off2() }
  }, [load])

  if (!o) return null
  const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))
  const install = async (id: string) => { setErr(null); try { await window.asi.voice.install(id) } catch (e) { setErr(clean(e)) } finally { setProg((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id))); await load() } }
  const apple = o.engines.find((e) => e.id === 'apple')
  const cohereOn = o.engines.find((e) => e.id === 'cohere-mlx')

  return (
    <section data-testid="voice-settings">
      <h3>Voice</h3>
      <p className="hint">Hold <kbd>⌥Space</kbd> in a chat to talk. Everything is transcribed on this Mac. Nothing is uploaded, and there is no cloud option.</p>
      <label className="engine" data-engine="apple">
        <input type="radio" name="engine" aria-label="Use Apple on-device speech" checked={o.selected === 'apple'} disabled={!apple?.available} onChange={() => void window.asi.voice.select('apple')} />
        <span className="grow"><b>Apple on-device speech</b><span className="meta">Ready now. No download. Good for everyday dictation.</span></span>
        <span className="chip">{apple?.available ? '✔ ready' : 'unavailable'}</span>
      </label>
      {o.models.map(({ model, status, installing, neededBytes }) => {
        const p = prog[model.id]
        const pct = p && p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0
        return (
          <div key={model.id} className="engine" data-engine={model.id} data-installed={status.installed ? 'yes' : 'no'}>
            <input type="radio" name="engine" aria-label={`Use ${model.name}`} checked={o.selected === 'cohere-mlx' && status.installed} disabled={!status.installed || !cohereOn?.available} onChange={() => void window.asi.voice.select('cohere-mlx')} />
            <span className="grow">
              <b>{model.name}{model.recommended ? ' · recommended' : ''}</b>
              <span className="meta">{model.blurb}</span>
              {installing || p ? (
                <>
                  <span className="meta" data-testid="voice-progress">{PHASE[p?.phase ?? 'checking']}{p?.line ? `: ${p.line}` : ''}{p?.phase === 'downloading' ? ` ${pct}% (${fmtBytes(p.received)} of ${fmtBytes(p.total)})` : ''}</span>
                  <span className="bar"><i style={{ width: `${p?.phase === 'downloading' ? pct : p?.phase === 'done' ? 100 : 5}%` }} /></span>
                </>
              ) : status.installed ? (
                <span className="meta">Installed · {fmtBytes(model.bytes)} on disk</span>
              ) : (
                <span className="meta">Download {fmtBytes(model.bytes)}{o.runtimeInstalled ? '' : ' + about 0.4 GB runtime'}. Needs {fmtBytes(neededBytes)} free; you have {fmtBytes(o.freeBytes)}.{status.partialBytes ? ` Resumes from ${fmtBytes(status.partialBytes)}.` : ''}</span>
              )}
            </span>
            {installing ? <Btn onClick={() => void window.asi.voice.cancel(model.id)}>Cancel</Btn>
              : status.installed ? <Btn onClick={() => void window.asi.voice.remove(model.id).then(load)}>Remove</Btn>
              : <Btn kind="primary" disabled={o.freeBytes > 0 && o.freeBytes < neededBytes} onClick={() => void install(model.id)}>Download</Btn>}
          </div>
        )
      })}
      {err ? <div className="note bad" role="alert">{err}</div> : null}
    </section>
  )
}
