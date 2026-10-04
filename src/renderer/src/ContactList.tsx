import { useMemo, useState } from 'react'
import { groupFriends } from '@shared/grouping'
import { avatarFor } from '@shared/harness-meta'
import { PRESENCE_LABEL, type Presence } from '@shared/status'
import { Avatar, Banner, Btn, StatusDot, WindowFrame } from './ui/kit'
import { useData } from './store'

type Tab = 'friends' | 'chats' | 'labels'
const SELECTABLE: Presence[] = ['online', 'busy', 'away', 'offline']

export function ContactList() {
  const { friends, chats, profile, setProfile } = useData()
  const [tab, setTab] = useState<Tab>('friends')
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const { groups, live } = useMemo(() => groupFriends(friends, chats, {}, filter), [friends, chats, filter])
  const friendById = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends])
  const unreadTotal = chats.reduce((n, c) => n + c.unreadCount, 0)

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
                  return (
                    <div key={id} className="contact" data-friend={f.displayName} data-presence={l.presence}>
                      <Avatar label={a.label} gradient={a.gradient} presence={l.presence} size="sm" working={l.presence === 'busy'} waiting={l.presence === 'away'} />
                      <div className="who">
                        <div className="nm">
                          <StatusDot presence={l.presence} />
                          {f.displayName}
                          {l.unread > 0 ? <span className="badge">{l.unread}</span> : null}
                        </div>
                        <div className="st funky">{l.message ?? (l.presence === 'offline' ? 'not available' : '')}</div>
                      </div>
                    </div>
                  )
                })}
            </div>
          ))}

        {tab === 'chats' &&
          (chats.length === 0 ? (
            <div className="empty">No chats yet. Double-click a friend to start one.</div>
          ) : (
            chats.map((c) => (
              <div key={c.id} className="contact" data-chat={c.title}>
                <div className="who">
                  <div className="nm">{c.title}{c.unreadCount > 0 ? <span className="badge">{c.unreadCount}</span> : null}</div>
                  <div className="st">{friendById.get(c.friendId)?.displayName}</div>
                </div>
              </div>
            ))
          ))}

        {tab === 'labels' && <div className="empty">Labels you add to friends and chats will group them here.</div>}
        {tab === 'friends' && groups.length === 0 && <div className="empty">No friends match “{filter}”.</div>}
      </div>

      <div className="foot">
        <Btn className="wide" disabled title="Registering a CLI arrives with the friends registry">＋ Add a friend</Btn>
      </div>
    </WindowFrame>
  )
}
