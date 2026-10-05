import { useMemo, useState } from 'react'
import { groupFriends } from '@shared/grouping'
import { avatarFor } from '@shared/harness-meta'
import { PRESENCE_LABEL, type Presence } from '@shared/status'
import { Avatar, Banner, Btn, StatusDot, WindowFrame } from './ui/kit'
import { useData } from './store'
import { UsageStrip } from './UsageStrip'
import { LabelChips, LabelEditor } from './LabelEditor'
import type { Chat } from '@shared/models'

type Tab = 'friends' | 'chats' | 'labels'
const SELECTABLE: Presence[] = ['online', 'busy', 'away', 'offline']

/** Waiting-on-you first, then working, then the rest by most recent activity. */
const RANK: Record<string, number> = { away: 0, busy: 1 }
const byUrgency = (a: Chat, b: Chat): number => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2) || b.lastActivityAt - a.lastActivityAt

export function ContactList() {
  const { friends, chats, availability, labels, friendLabels, chatLabels, profile, setProfile, workspaces, activeWorkspaceId, setActiveWorkspace, addWorkspaceFromFolder, openFriend, newChatWith, newIsolatedChatWith, openChat } = useData()
  const [tab, setTab] = useState<Tab>('friends')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [labeling, setLabeling] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const friendById = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends])
  const wsChats = useMemo(() => chats.filter((c) => c.workspaceId === activeWorkspaceId), [chats, activeWorkspaceId])
  // a friend's row reflects the chats in this workspace, so five Claudes in one folder read as one friend with five sessions
  const { groups, live } = useMemo(() => groupFriends(friends, wsChats, availability, filter), [friends, wsChats, availability, filter])
  const [note, setNote] = useState<string | null>(null)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const chatsByFriend = useMemo(() => {
    const m = new Map<string, Chat[]>()
    for (const c of wsChats) m.set(c.friendId, [...(m.get(c.friendId) ?? []), c])
    for (const [k, v] of m) m.set(k, v.sort(byUrgency))
    return m
  }, [wsChats])
  const orderedChats = useMemo(() => [...wsChats].sort(byUrgency), [wsChats])
  const unreadTotal = wsChats.reduce((n, c) => n + c.unreadCount, 0)

  return (
    <WindowFrame title="ASI Messenger">
      <Banner
        avatar={<Avatar label={profile.name.slice(0, 1).toUpperCase() || 'A'} gradient={['#e05297', '#f39ac2']} presence={profile.presence} size="lg" />}
        name={
          <>
            <span data-testid="profile-name">{profile.name}</span>
            <select
              aria-label="Your status"
              className="presence-select"
              value={profile.presence}
              onChange={(e) => void setProfile({ presence: e.target.value as Presence })}
            >
              {SELECTABLE.map((p) => (
                <option key={p} value={p}>({PRESENCE_LABEL[p]})</option>
              ))}
            </select>
          </>
        }
        message={
          <input
            className="pm-input"
            aria-label="Personal message"
            placeholder="<Type a personal message>"
            value={profile.personalMessage}
            onChange={(e) => void setProfile({ personalMessage: e.target.value })}
          />
        }
      />

      <UsageStrip />

      <div className="ws" role="tablist" aria-label="Workspaces">
        {workspaces.map((w) => (
          <button
            key={w.id}
            role="tab"
            aria-selected={w.id === activeWorkspaceId}
            className={w.id === activeWorkspaceId ? 'sel' : ''}
            title={w.path}
            data-workspace={w.name}
            onClick={() => void setActiveWorkspace(w.id)}
          >
            {w.slot ? <span className="slot">⌘{w.slot}</span> : null} {w.name}
          </button>
        ))}
        <button className="add" aria-label="Add workspace" title="Add a workspace folder" onClick={() => void addWorkspaceFromFolder()}>＋</button>
      </div>

      <div className="searchbar">
        <input
          className="field"
          placeholder="Find a friend…"
          aria-label="Find a friend"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="tabs2" role="tablist">
        {(['friends', 'chats', 'labels'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'sel' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
            {t === 'chats' && unreadTotal > 0 ? <span className="badge">{unreadTotal}</span> : null}
          </button>
        ))}
      </div>

      <div className="contacts" data-testid="contacts">
        {tab === 'friends' &&
          groups.map((g) => (
            <div key={g.id} data-group={g.id}>
              <button className="grp" onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}>
                <span className="caret">{collapsed[g.id] ? '▸' : '▾'}</span>
                {g.title} ({g.friendIds.length})
              </button>
              {!collapsed[g.id] &&
                g.friendIds.map((id) => {
                  const f = friendById.get(id)!
                  const l = live[id]!
                  const a = avatarFor(f)
                  const mine = chatsByFriend.get(id) ?? []
                  const nested = mine.length > 1 && !closed[id]
                  return (
                    <div key={id} className="friend-block">
                    <div
                      className={`contact${selected === id ? ' sel' : ''}`}
                      data-friend={f.displayName}
                      data-presence={l.presence}
                      onClick={() => setSelected(id)}
                      onDoubleClick={() => void openFriend(id)}
                    >
                      <Avatar label={a.label} gradient={a.gradient} presence={l.presence} size="sm" working={l.presence === 'busy'} waiting={l.presence === 'away'} />
                      <div className="who">
                        <div className="nm">
                          <StatusDot presence={l.presence} />
                          {f.displayName}
                          {mine.length > 1 ? (
                            <button className="count" aria-expanded={nested} title={nested ? 'Hide this friend’s chats' : 'Show this friend’s chats'} onClick={(e) => { e.stopPropagation(); setClosed((c) => ({ ...c, [id]: nested })) }}>
                              {nested ? '▾' : '▸'} ×{mine.length}
                            </button>
                          ) : null}
                          <LabelChips ids={friendLabels[id] ?? []} />
                          {mine.some((c) => c.mode === 'dangerous') ? <span className="danger-badge" title="A chat with this friend is in dangerous mode">⚠</span> : null}
                          {l.unread > 0 ? <span className="badge">{l.unread}</span> : null}
                        </div>
                        <div className={`st${f.letteringStyle === 'plain' ? '' : ' funky'}`} title={l.message ?? undefined}>{l.message ?? (l.presence === 'offline' ? 'not available' : '')}</div>
                      </div>
                    </div>
                    {nested ? mine.map((c) => (
                      <div key={c.id} className="subchat" data-subchat={c.title} data-presence={c.status} onDoubleClick={() => void openChat(c.id)} title="Double-click to open this chat">
                        <StatusDot presence={c.status as Presence} />
                        <div className="who">
                          <div className="nm">{c.title}{c.branch ? <span className="branch" title={c.worktreePath ?? undefined}>⎇ {c.branch.replace(/^asi\//, '')}</span> : null}{c.mode === 'dangerous' ? <span className="danger-badge" title="Dangerous mode">⚠</span> : null}{c.unreadCount > 0 ? <span className="badge">{c.unreadCount}</span> : null}</div>
                          <div className={`st${f.letteringStyle === 'plain' ? '' : ' funky'}`} title={c.statusText ?? undefined}>{c.statusText ?? PRESENCE_LABEL[c.status as Presence]}</div>
                        </div>
                      </div>
                    )) : null}
                    </div>
                  )
                })}
            </div>
          ))}

        {tab === 'chats' &&
          (wsChats.length === 0 ? (
            <div className="empty">No chats in this workspace yet. Double-click a friend to start one.</div>
          ) : (
            orderedChats.map((c) => {
              const f = friendById.get(c.friendId)
              const a = f ? avatarFor(f) : { label: '?', gradient: ['#6b7a99', '#a4b0c8'] as [string, string] }
              const pres = c.status as Presence
              return (
                <div key={c.id} className="contact chatrow" data-chat={c.title} data-presence={pres} onDoubleClick={() => void openChat(c.id)} title="Double-click to open">
                  <Avatar label={a.label} gradient={a.gradient} presence={pres} size="sm" working={pres === 'busy'} waiting={pres === 'away'} />
                  <div className="who">
                    <div className="nm">
                      {c.title}
                      {c.branch ? <span className="branch" title={c.worktreePath ?? undefined}>⎇ {c.branch.replace(/^asi\//, '')}</span> : null}
                      <LabelChips ids={chatLabels[c.id] ?? []} />
                      {c.mode === 'dangerous' ? <span className="danger-badge" title="Dangerous mode">⚠</span> : null}
                      {c.unreadCount > 0 ? <span className="badge">{c.unreadCount}</span> : null}
                    </div>
                    <div className={`st${f?.letteringStyle === 'plain' ? '' : ' funky'}`} title={c.statusText ?? undefined}>
                      <span className="who-tag">{f?.displayName}</span> {c.statusText ?? PRESENCE_LABEL[pres]}
                    </div>
                  </div>
                </div>
              )
            })
          ))}

        {tab === 'labels' && labels.length === 0 && <div className="empty">Labels you add to friends and chats will group them here.</div>}
        {tab === 'labels' &&
          labels.map((l) => {
            const fs = friends.filter((f) => (friendLabels[f.id] ?? []).includes(l.id))
            const cs = wsChats.filter((c) => (chatLabels[c.id] ?? []).includes(l.id))
            return (
              <div key={l.id} className="lbl-group" data-label-group={l.name}>
                <div className="grp"><span className="swatch" style={{ background: l.color ?? 'var(--accent)' }} /> {l.name} ({fs.length + cs.length})</div>
                {fs.map((f) => (<div key={f.id} className="contact" data-friend={f.displayName} onDoubleClick={() => void openFriend(f.id)}><div className="who"><div className="nm">{f.displayName}</div><div className="st">friend</div></div></div>))}
                {cs.map((c) => (<div key={c.id} className="contact" data-chat={c.title} onDoubleClick={() => void openChat(c.id)}><div className="who"><div className="nm">{c.title}</div><div className="st">{friendById.get(c.friendId)?.displayName}</div></div></div>))}
              </div>
            )
          })}
        {tab === 'friends' && groups.length === 0 && <div className="empty">No friends match “{filter}”.</div>}
      </div>

      <div className="foot">
        {labeling && selected ? <LabelEditor target={{ kind: 'friend', id: selected }} onClose={() => setLabeling(false)} /> : null}
        <Btn className="wide" disabled={!selected} onClick={() => setLabeling((v) => !v)} title="Add or remove labels on the selected friend">🏷 Label selected friend</Btn>
        <Btn className="wide" disabled={!selected} onClick={() => { setNote(null); if (selected) void newChatWith(selected) }} title="Start a new chat with the selected friend (⌘N)">New chat with selected friend</Btn>
        <Btn className="wide" disabled={!selected} onClick={() => { setNote(null); if (selected) void newIsolatedChatWith(selected).catch((e: unknown) => setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))) }} title="Start the chat on its own git branch in its own folder, so it cannot collide with other agents working in this repo">⎇ New chat in its own worktree</Btn>
        {note ? <div className="foot-note" role="status">{note}</div> : null}
        <Btn className="wide" onClick={() => void window.asi.friends.openAddWindow()} title="Register a coding agent CLI (⌘⇧N)">＋ Add a friend</Btn>
      </div>
    </WindowFrame>
  )
}
