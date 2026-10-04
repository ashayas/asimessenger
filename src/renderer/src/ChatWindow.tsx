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
import { LabelChips, LabelEditor } from './LabelEditor'
import { TerminalDrawer } from './TerminalDrawer'
import { resumeCommand } from '@shared/resume'
import { play } from './sounds'
import { startRecording, type Recording } from './voice'

/** Stable empty array: zustand selectors must not return a fresh [] each render. */
const NO_LABELS: string[] = []

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
  const [editingLabels, setEditingLabels] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const chatLabelIds = useData((s) => s.chatLabels[chatId] ?? NO_LABELS)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '`') { e.preventDefault(); setDrawer((v) => !v) }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); setEditingLabels((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const endRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const rec = useRef<Recording | null>(null)
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceNote, setVoiceNote] = useState<string | null>(null)

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

  const startVoice = useCallback(async () => {
    if (rec.current) return
    setVoiceNote(null)
    try { rec.current = await startRecording(); setVoice('recording') } catch (e) { setVoiceNote(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`) }
  }, [])
  const stopVoice = useCallback(async () => {
    const r = rec.current
    if (!r) return
    rec.current = null
    setVoice('transcribing')
    try {
      const { text } = await window.asi.voice.transcribe(await r.stop())
      if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
      composerRef.current?.focus()
    } catch (e) {
      setVoiceNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))
    } finally { setVoice('idle') }
  }, [])
  const toggleVoice = () => void (rec.current ? stopVoice() : startVoice())

  // hold ⌥Space to talk
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && e.altKey && !e.repeat) { e.preventDefault(); void startVoice() } }
    const up = (e: KeyboardEvent) => { if (rec.current && (e.code === 'Space' || e.key === 'Alt')) { e.preventDefault(); void stopVoice() } }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [startVoice, stopVoice])

  const live = useMemo(() => (friend ? liveFor(friend, allChats.filter((c) => c.id === chatId), isBuiltin(friend.harness)) : null), [friend, allChats, chatId])

  if (!chat || !friend) return <WindowFrame title="ASI Messenger"><div className="empty">Loading…</div></WindowFrame>

  const style = avatarFor(friend)
  const terminalPossible = friend.harness === 'pty' || resumeCommand(friend, chat, '/') !== null
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
        <ToolButton icon="📎" label="Send Files" onClick={() => void window.asi.attachments.pickFiles().then(async (paths) => { if (paths.length) await window.asi.attachments.sendFiles(chatId, paths) })} />
        <ToolButton icon="✏️" label="Doodle" onClick={() => void window.asi.doodle.open(chat.workspaceId, { chatId })} />
        <ToolButton icon="🌐" label="Browser" onClick={() => void window.asi.browser.open('about:blank')} />
        <ToolButton icon={voice === 'recording' ? '⏺' : '🎙'} label={voice === 'recording' ? 'Stop & type' : 'Voice Clip'} disabled={voice === 'transcribing'} onClick={toggleVoice} />
        <ToolButton icon="⌨" label="Terminal" disabled={!terminalPossible} onClick={() => (friend.harness === 'pty' ? setDrawer((v) => !v) : void window.asi.pty.openExternal(chatId))} />
        <ToolButton icon="📳" label="Nudge" onClick={() => void window.asi.chat.nudge(chatId).then((sent) => { if (sent) play('nudge') })} />
        <ToolButton icon="⏹" label="Stop" stop onClick={() => void window.asi.chat.interrupt(chatId)} />
      </div>
      <div className="to">
        <b>To:</b> {friend.displayName} <StatusDot presence={presence} />
        {live?.message ? <span className={friend.letteringStyle === 'plain' ? '' : 'funky'}> — {live.message}</span> : null}
        <span className="grow" />
        <LabelChips ids={chatLabelIds} />
        <button className="linkish" onClick={() => setEditingLabels((v) => !v)} title="Label this chat (⌘L)">🏷 Label</button>
      </div>
      {editingLabels ? <LabelEditor target={{ kind: 'chat', id: chatId }} onClose={() => setEditingLabels(false)} /> : null}
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
      {drawer && friend.harness === 'pty' ? <TerminalDrawer chatId={chatId} /> : null}
      {voice !== 'idle' || voiceNote ? (
        <div className={`voice-note${voice === 'recording' ? ' rec' : ''}`} role="status" data-voice={voice}>
          {voice === 'recording' ? '● Recording… release ⌥Space (or click Stop & type) to transcribe' : voice === 'transcribing' ? 'Transcribing on this Mac…' : voiceNote}
          <span className="grow" />
          <span className="priv">🔒 on this Mac only</span>
        </div>
      ) : null}
      {modeNote ? (
        <div className="mode-note" role="status">
          <span className="grow">{modeNote}</span>
          <Btn onClick={() => void window.asi.safety.openOptions()}>Open Options</Btn>
        </div>
      ) : null}
      {friend.harness === 'asi' || friend.harness === 'echo' ? null : (
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
      )}
      <div className="composer">
        <textarea
          ref={composerRef}
          className="field"
          aria-label="Message"
          placeholder={`Reply to ${friend.displayName}… (! runs a shell command, /open opens a URL or file)`}
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
