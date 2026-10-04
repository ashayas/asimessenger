import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat, Friend, Message } from '@shared/models'
import { avatarFor } from '@shared/harness-meta'
import { isBuiltin, liveFor } from '@shared/grouping'
import { Avatar, Btn, StatusDot, ToolButton, WindowFrame } from './ui/kit'
import { useData } from './store'
import { useSetting } from './hooks'
import { MODE_LABEL, canUseMode, lockedReason } from '@shared/safety'
import type { Mode } from '@shared/models'
import { MessageView } from './MessageViews'
import { play } from './sounds'

function useChat(chatId: string) {
  const [chat, setChat] = useState<Chat | null>(null)
  const [friend, setFriend] = useState<Friend | null>(null)
  const [messages, setMessages] = useState<Message[]>([])

  const load = useCallback(async () => {
    const c = await window.asi.api.chats.get(chatId)
    setChat(c)
    if (c) {
      setFriend(await window.asi.api.friends.get(c.friendId))
      setMessages(await window.asi.api.messages.list(chatId))
    }
  }, [chatId])

  useEffect(() => {
    void load()
    return window.asi.onChanged(() => void load())
  }, [load])
  return { chat, friend, messages }
}

export function ChatWindow({ chatId }: { chatId: string }) {
  const { chat, friend, messages } = useChat(chatId)
  const profile = useData((s) => s.profile)
  const allChats = useData((s) => s.chats)
  const [draft, setDraft] = useState('')
  const [globalDangerous] = useSetting<boolean>('allowDangerous', false)
  const [modeNote, setModeNote] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (chat) document.title = `${chat.title} · ${friend?.displayName ?? ''}`.trim()
  }, [chat, friend])

  // mark read only while you are actually looking at the window
  useEffect(() => {
    if (chat && chat.unreadCount > 0) void window.asi.windowFocused().then((f) => { if (f) void window.asi.api.chats.markRead(chatId) })
  }, [chat, chatId])
  useEffect(() => {
    const onFocus = () => void window.asi.api.chats.markRead(chatId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [chatId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const live = useMemo(() => (friend ? liveFor(friend, allChats.filter((c) => c.id === chatId), isBuiltin(friend.harness)) : null), [friend, allChats, chatId])

  if (!chat || !friend) return <WindowFrame title="ASI Messenger"><div className="empty">Loading…</div></WindowFrame>

  const style = avatarFor(friend)
  const presence = live?.presence ?? 'online'

  const safety = { globalDangerous, friendDangerous: friend.dangerousAllowed }
  const pickMode = async (m: Mode) => {
    setModeNote(null)
    if (!canUseMode(m, safety)) return setModeNote(lockedReason(safety))
    try { await window.asi.chat.setMode(chatId, m) } catch (err) { setModeNote(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err)) }
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void window.asi.chat.send(chatId, text)
  }

  // group consecutive messages by the same speaker under one "X says:"
  const blocks: { role: Message['role']; items: Message[] }[] = []
  for (const m of messages) {
    const last = blocks[blocks.length - 1]
    if (last && last.role === m.role) last.items.push(m)
    else blocks.push({ role: m.role, items: [m] })
  }

  return (
    <WindowFrame title={`${chat.mode === 'dangerous' ? '⚠ DANGEROUS · ' : ''}${chat.title} · ${friend.displayName} · Conversation`} danger={chat.mode === 'dangerous'}>
      <div className="toolbar">
        <ToolButton icon="👥" label="Invite" disabled />
        <ToolButton icon="📎" label="Send Files" disabled />
        <ToolButton icon="✏️" label="Doodle" disabled />
        <ToolButton icon="🌐" label="Browser" disabled />
        <ToolButton icon="🎙" label="Voice Clip" disabled />
        <ToolButton icon="⌨" label="Terminal" disabled />
        <ToolButton icon="📳" label="Nudge" onClick={() => void window.asi.chat.nudge(chatId).then((sent) => { if (sent) play('nudge') })} />
        <ToolButton icon="⏹" label="Stop" stop onClick={() => void window.asi.chat.interrupt(chatId)} />
      </div>
      <div className="to">
        <b>To:</b> {friend.displayName} <StatusDot presence={presence} />
        {live?.message ? <span className="funky"> — {live.message}</span> : null}
      </div>
      <div className="convo">
        <div className="transcript" data-testid="transcript">
          {blocks.length === 0 && <div className="empty">Say something to {friend.displayName}.</div>}
          {blocks.map((b, i) => (
            <div key={i} className="block" data-role={b.role}>
              <div className="says"><b>{b.role === 'user' ? profile.name : b.role === 'agent' ? friend.displayName : 'ASI'}</b> says:</div>
              {b.items.map((m) => (
                <MessageView key={m.id} m={m} chatId={chatId} />
              ))}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="side">
          <Avatar label={style.label} gradient={style.gradient} presence={presence} size="xl" working={presence === 'busy'} waiting={presence === 'away'} />
          <Avatar label={profile.name.slice(0, 1).toUpperCase() || 'A'} gradient={['#e05297', '#f39ac2']} presence={profile.presence} size="xl" />
        </div>
      </div>
      {modeNote ? (
        <div className="mode-note" role="status">
          <span className="grow">{modeNote}</span>
          <Btn onClick={() => void window.asi.safety.openOptions()}>Open Options</Btn>
        </div>
      ) : null}
      <div className="modes" role="radiogroup" aria-label="Permission mode">
        {(['ask', 'auto-edit', 'plan', 'dangerous'] as Mode[]).map((m) => {
          const locked = !canUseMode(m, safety)
          return (
            <button
              key={m}
              role="radio"
              aria-checked={chat.mode === m}
              data-mode={m}
              className={`mode${chat.mode === m ? ' sel' : ''}${locked ? ' locked' : ''}${m === 'dangerous' ? ' dangerous' : ''}`}
              title={locked ? (lockedReason(safety) ?? '') : MODE_LABEL[m]}
              onClick={() => void pickMode(m)}
            >
              {m === 'ask' ? '🛡' : m === 'auto-edit' ? '✎' : m === 'plan' ? '▤' : '⚠'} {MODE_LABEL[m]}{locked ? ' (locked)' : ''}
            </button>
          )
        })}
      </div>
      <div className="composer">
        <textarea
          className="field"
          aria-label="Message"
          placeholder={`Reply to ${friend.displayName}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          autoFocus
        />
        <button className="btn primary" onClick={send} disabled={!draft.trim()}>Send</button>
      </div>
    </WindowFrame>
  )
}
