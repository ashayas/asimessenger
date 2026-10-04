import { useState } from 'react'
import { Btn } from './ui/kit'
import { useData } from './store'

const COLORS = ['#6b3fa0', '#1652c7', '#1e8a3c', '#c47a00', '#c2410c', '#be185d']

/** Add/remove labels on a friend or a chat. Type a new name to create one. */
export function LabelEditor(props: { target: { kind: 'friend' | 'chat'; id: string }; onClose(): void }) {
  const { labels, friendLabels, chatLabels } = useData()
  const [name, setName] = useState('')
  const current = (props.target.kind === 'friend' ? friendLabels : chatLabels)[props.target.id] ?? []

  const save = async (ids: string[]) => {
    const api = window.asi.api.labels
    if (props.target.kind === 'friend') await api.setForFriend(props.target.id, ids)
    else await api.setForChat(props.target.id, ids)
  }
  const toggle = (id: string) => void save(current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  const create = async () => {
    const n = name.trim()
    if (!n) return
    const existing = labels.find((l) => l.name.toLowerCase() === n.toLowerCase())
    const label = existing ?? (await window.asi.api.labels.create(n, COLORS[labels.length % COLORS.length]!))
    if (!current.includes(label.id)) await save([...current, label.id])
    setName('')
  }

  return (
    <div className="label-editor" role="dialog" aria-label="Labels">
      <div className="le-list">
        {labels.length === 0 && <span className="empty-inline">No labels yet. Type a name to make one.</span>}
        {labels.map((l) => (
          <label key={l.id} className="le-item">
            <input type="checkbox" checked={current.includes(l.id)} onChange={() => toggle(l.id)} aria-label={`Label ${l.name}`} />
            <span className="swatch" style={{ background: l.color ?? 'var(--accent)' }} />
            {l.name}
          </label>
        ))}
      </div>
      <div className="le-new">
        <input className="field" aria-label="New label" placeholder="New label…" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') props.onClose() }} />
        <Btn onClick={() => void create()} disabled={!name.trim()}>Add</Btn>
        <Btn onClick={props.onClose}>Done</Btn>
      </div>
    </div>
  )
}

export function LabelChips({ ids }: { ids: string[] }) {
  const labels = useData((s) => s.labels)
  return (
    <>
      {ids.map((id) => {
        const l = labels.find((x) => x.id === id)
        return l ? <span key={id} className="lchip" data-label={l.name} style={{ background: l.color ?? 'var(--accent)' }}>{l.name}</span> : null
      })}
    </>
  )
}
