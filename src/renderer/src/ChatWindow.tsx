import { fileBadge, fmtBytes, imageMime, MAX_FILE_BYTES } from '@shared/attachments'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardEntry, Chat, ChatParticipant, Friend, Message } from '@shared/models'
import { formatBoardEntry } from '@shared/board'
import { avatarFor } from '@shared/harness-meta'
import { isBuiltin, liveFor } from '@shared/grouping'
import { useQueued } from './queue-hooks'
import { useChatUsage } from './usage-hooks'
import { spendLine } from './UsageParts'
import { fmtTokens } from '@shared/usage'
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
  const [participants, setParticipants] = useState<ChatParticipant[]>([])
  const [boardEntries, setBoardEntries] = useState<BoardEntry[]>([])

  const load = useCallback(async () => {
    const c = await window.asi.api.chats.get(chatId)
    setChat(c)
    if (c) {
      setFriend(await window.asi.api.friends.get(c.friendId))
      setMessages(await window.asi.api.messages.list(chatId))
      setParticipants(await window.asi.api.participants.list(chatId))
      setBoardEntries(await window.asi.api.board.list(chatId))
    }
  }, [chatId])

  useEffect(() => {
    void load()
    return window.asi.onChanged(() => void load())
  }, [load])
  return { chat, friend, messages, participants, boardEntries }
}

/** Unsent text survives switching tabs (only the active tab is mounted). */
const drafts = new Map<string, string>()

/** Client-side rate-limit so nudge sound and action trigger immediately. */
const clientLastNudge = new Map<string, number>()

export function ChatWindow({ chatId, embedded = false }: { chatId: string; embedded?: boolean }) {
  const { chat, friend, messages, participants, boardEntries } = useChat(chatId)
  const chatUsage = useChatUsage(chatId)
  const queued = useQueued(chatId)
  /** While on, Enter holds your message until the agent finishes instead of sending it straight away. */
  const [autoQueue, setAutoQueue] = useState(false)
  const profile = useData((s) => s.profile)
  const allChats = useData((s) => s.chats)
  const allFriends = useData((s) => s.friends)
  const workspaces = useData((s) => s.workspaces)
  const [draft, setDraftState] = useState(() => drafts.get(chatId) ?? '')
  const setDraft = useCallback((v: string | ((d: string) => string)) => setDraftState((d) => { const n = typeof v === 'function' ? v(d) : v; drafts.set(chatId, n); return n }), [chatId])
  const [globalDangerous] = useSetting<boolean>('allowDangerous', false)
  const [modeNote, setModeNote] = useState<string | null>(null)
  const [editingLabels, setEditingLabels] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteFriendId, setInviteFriendId] = useState('')
  const [inviteRole, setInviteRole] = useState('')
  const [goalDraft, setGoalDraft] = useState('')
  const [goalDirty, setGoalDirty] = useState(false)
  const [targetParticipantId, setTargetParticipantId] = useState<string>('')
  const [showBoardLog, setShowBoardLog] = useState(false)
  const [boardGrep, setBoardGrep] = useState('')
  const [boardPath, setBoardPath] = useState<string | null>(null)
  /** Pictures and files waiting to go out with the next message (dropped, pasted). */
  const [pending, setPending] = useState<{ id: string; name: string; path: string; preview?: string; size?: number }[]>([])
  const [dropping, setDropping] = useState(false)
  const [attachNote, setAttachNote] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ branch: string | null; dirty: number; isolated: boolean } | null>(null)
  const chatLabelIds = useData((s) => s.chatLabels[chatId] ?? NO_LABELS)
  const workspace = useMemo(() => workspaces.find((w) => w.id === chat?.workspaceId) ?? null, [workspaces, chat?.workspaceId])

  useEffect(() => {
    if (!goalDirty) setGoalDraft(chat?.goal ?? '')
  }, [chat?.goal, goalDirty])

  useEffect(() => {
    if (!inviteFriendId && friend) setInviteFriendId(friend.id)
  }, [inviteFriendId, friend])

  useEffect(() => {
    if (inviteOpen || participants.length > 0 || chat?.goal) {
      void window.asi.chat.boardPath(chatId).then(setBoardPath).catch(() => {})
    }
  }, [inviteOpen, participants.length, chat?.goal, chatId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '`') { e.preventDefault(); setDrawer((v) => !v) }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); setAutoQueue((v) => !v) }
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
      const { text, silent } = await window.asi.voice.transcribe(await r.stop())
      if (silent) setVoiceNote('I did not hear anything. Check the input device and volume in System Settings, Sound.')
      if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
      composerRef.current?.focus()
    } catch (e) {
      setVoiceNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))
    } finally { setVoice('idle') }
  }, [])
  const addFiles = useCallback(async (files: File[]) => {
    setAttachNote(null)
    for (const f of files) {
      try {
        const name = f.name || 'image.png'
        const isImage = imageMime(name) !== null || f.type.startsWith('image/')
        const real = window.asi.attachments.pathFor(f)
        const preview = isImage ? await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f) }) : undefined
        // a pasted picture has no file on disk: save it into the workspace first
        if (f.size > MAX_FILE_BYTES) throw new Error(`${name} is larger than ${MAX_FILE_BYTES / 1024 ** 3} GB`)
        // a file dragged in from Finder has a path and is never read into memory; a pasted one has only bytes
        const path = real || (isImage ? await window.asi.attachments.saveImage(chatId, name, new Uint8Array(await f.arrayBuffer())) : await window.asi.attachments.saveFile(chatId, name, new Uint8Array(await f.arrayBuffer())))
        if (!path) throw new Error(`could not read ${name}`)
        setPending((p) => [...p, { id: `${Date.now()}-${Math.random()}`, name, path, preview, size: f.size }])
      } catch (e) {
        setAttachNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))
      }
    }
    composerRef.current?.focus()
  }, [chatId])
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } },
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDropping(false) },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDropping(false); void addFiles(Array.from(e.dataTransfer.files)) }
  }
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

  const onNudge = useCallback(() => {
    const now = Date.now()
    if (now - (clientLastNudge.get(chatId) ?? 0) < 3000) return
    clientLastNudge.set(chatId, now)
    play('nudge')
    void window.asi.chat.nudge(chatId)
  }, [chatId])

  const filteredBoardEntries = useMemo(() => {
    const q = boardGrep.trim().toLowerCase()
    if (!q) return boardEntries
    return boardEntries.filter((e) => formatBoardEntry(e).toLowerCase().includes(q))
  }, [boardEntries, boardGrep])

  const Frame = embedded ? EmbeddedFrame : WindowFrame
  if (!chat || !friend) return <Frame title="ASI Messenger"><div className="empty">Loading…</div></Frame>

  const style = avatarFor(friend)
  const terminalPossible = friend.harness === 'pty' || resumeCommand(friend, chat, '/') !== null
  const presence = live?.presence ?? 'online'

  const safety = { globalDangerous, friendDangerous: friend.dangerousAllowed }
  const pickMode = async (m: Mode) => {
    setModeNote(null)
    if (!canUseMode(m, safety)) return setModeNote(lockedReason(safety))
    try { await window.asi.chat.setMode(chatId, m) } catch (err) { setModeNote(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err)) }
  }

  const handleInvite = async () => {
    const fId = inviteFriendId || friend.id
    await window.asi.chat.invite(chatId, fId, inviteRole.trim() || undefined)
    setInviteRole('')
  }

  const handleSaveGoal = async () => {
    const p = await window.asi.chat.setGoal(chatId, goalDraft.trim() || null)
    setBoardPath(p)
    setGoalDirty(false)
  }

  const send = () => {
    const text = draft.trim()
    if (pending.length) {
      const paths = pending.map((p) => p.path)
      setPending([])
      setDraft('')
      void window.asi.attachments.sendFiles(chatId, paths, text).catch((e: unknown) => setAttachNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)))
      return
    }
    if (!text) return
    setDraft('')
    const slash = /^\/queue\s+([\s\S]+)$/.exec(text)
    if (slash) return void window.asi.chat.queue(chatId, slash[1]!)
    if (autoQueue && (presence === 'busy' || presence === 'away')) return void window.asi.chat.queue(chatId, text)
    void window.asi.chat.send(chatId, text, undefined, targetParticipantId || undefined)
  }

  // group consecutive messages by the same speaker under one "X says:"
  const blocks: { role: Message['role']; speaker: string; items: Message[] }[] = []
  for (const m of messages) {
    const sp =
      m.role === 'user'
        ? profile.name
        : m.role === 'system'
          ? 'ASI'
          : ((m.body as { speaker?: { speakerName?: string } } | null)?.speaker?.speakerName ?? friend.displayName)
    const last = blocks[blocks.length - 1]
    if (last && last.role === m.role && last.speaker === sp) last.items.push(m)
    else blocks.push({ role: m.role, speaker: sp, items: [m] })
  }

  const isMultiAgent = participants.length > 0 || !!(chat.goal && chat.goal.trim())

  return (
    <Frame title={`${chat.mode === 'dangerous' ? '⚠ DANGEROUS · ' : ''}${chat.title} · ${friend.displayName} · Conversation`} danger={chat.mode === 'dangerous'}>
      <div className="toolbar">
        <ToolButton icon="👥" label="Invite" onClick={() => setInviteOpen((v) => !v)} />
        <ToolButton icon="📎" label="Send Files" onClick={() => void window.asi.attachments.pickFiles().then(async (paths) => { if (paths.length) await window.asi.attachments.sendFiles(chatId, paths) })} />
        <ToolButton icon="✏️" label="Doodle" onClick={() => void window.asi.doodle.open(chat.workspaceId, { chatId })} />
        <ToolButton icon="🌐" label="Browser" onClick={() => void window.asi.browser.open('about:blank')} />
        <ToolButton icon={voice === 'recording' ? '⏺' : '🎙'} label={voice === 'recording' ? 'Stop & type' : 'Voice Clip'} disabled={voice === 'transcribing'} onClick={toggleVoice} />
        <ToolButton icon="⌨" label="Terminal" disabled={!terminalPossible} onClick={() => (friend.harness === 'pty' ? setDrawer((v) => !v) : void window.asi.pty.openExternal(chatId))} />
        <ToolButton icon="📳" label="Nudge" onClick={onNudge} />
      </div>
      <div className="to">
        <b>To:</b> {friend.displayName} <StatusDot presence={presence} />
        {participants.length > 1 ? (
          <span className="participant-summary" data-testid="participant-summary">
            +{participants.length - 1} invited ({participants.map((p) => p.agentId).join(', ')})
          </span>
        ) : null}
        {live?.message ? <span className={friend.letteringStyle === 'plain' ? '' : 'funky'}> — {live.message}</span> : null}
        <span className="grow" />
        {isMultiAgent ? (
          <button
            className="linkish"
            data-testid="toggle-board-btn"
            onClick={() => { setInviteOpen(true); setShowBoardLog((v) => !v) }}
            title={boardPath ? `Shared session board: ${boardPath}` : 'Open shared session board'}
          >
            📋 Board ({boardEntries.length})
          </button>
        ) : null}
        {chatUsage && chatUsage.calls > 0 ? <span className="chat-usage" data-testid="chat-usage" title={`input ${fmtTokens(chatUsage.inputTokens)} · output ${fmtTokens(chatUsage.outputTokens)} · cached ${fmtTokens(chatUsage.cacheReadTokens + chatUsage.cacheWriteTokens)}${chatUsage.pricedCalls === 0 ? ` · this agent does not report cost` : ''}`}>{spendLine(chatUsage)}</span> : null}
        {workspace ? <span className="branch" data-testid="workspace-chip" title={chat.worktreePath ?? workspace.path}>📁 {workspace.name}</span> : null}
        {chat.branch ? <span className="branch" data-testid="branch" title={`Works in its own worktree: ${chat.worktreePath}`}>⎇ {chat.branch}</span> : null}
        <LabelChips ids={chatLabelIds} />
        {renaming ? (
          <input
            className="field"
            style={{ width: 160, minHeight: 20, padding: '1px 6px' }}
            aria-label="Chat title"
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const next = titleDraft.trim()
              setRenaming(false)
              if (next && next !== chat.title) void window.asi.api.chats.rename(chatId, next)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) }
            }}
          />
        ) : (
          <button className="linkish" aria-label="Rename chat" onClick={() => { setTitleDraft(chat.title); setRenaming(true) }} title={`Rename chat (${chat.title})`}>✎ Rename</button>
        )}
        {friend.harness !== 'asi' && friend.harness !== 'echo' ? (
          <button className="linkish" aria-label="Reset session" onClick={() => void window.asi.chat.reset(chatId)} title="Start a fresh agent session in this chat (/reset)">↺ Reset</button>
        ) : null}
        <button className="linkish" onClick={() => setEditingLabels((v) => !v)} title="Label this chat (⌘L)">🏷 Label</button>
        <button className="linkish" onClick={() => void window.asi.chat.worktreeInfo(chatId).then(setDeleting)} title="Delete this chat">🗑 Delete</button>
      </div>
      {inviteOpen ? (
        <div className="invite-panel" data-testid="invite-panel">
          <div className="invite-row">
            <label className="invite-lbl">Goal:</label>
            <input
              className="field grow"
              aria-label="Session goal"
              placeholder="Overall goal for all collaborating agents (placed at the top of the shared log file)…"
              value={goalDraft}
              onChange={(e) => { setGoalDraft(e.target.value); setGoalDirty(true) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSaveGoal() } }}
            />
            <Btn onClick={() => void handleSaveGoal()}>Save Goal</Btn>
            <button className="linkish" onClick={() => setShowBoardLog((v) => !v)}>{showBoardLog ? 'Hide Log' : `View Log (${boardEntries.length})`}</button>
            {boardPath ? (
              <button className="linkish" onClick={() => void window.asi.chat.openBoard(chatId)} title={boardPath}>Open .log</button>
            ) : null}
            <button className="linkish" aria-label="Close invite panel" onClick={() => setInviteOpen(false)}>✕</button>
          </div>
          <div className="invite-row">
            <label className="invite-lbl">Invite:</label>
            <select
              className="field"
              aria-label="Invite friend"
              value={inviteFriendId}
              onChange={(e) => setInviteFriendId(e.target.value)}
            >
              {allFriends.map((f) => (
                <option key={f.id} value={f.id}>{f.displayName} ({f.harness})</option>
              ))}
            </select>
            <input
              className="field grow"
              aria-label="Agent role"
              placeholder="Optional role / focus (e.g. backend, tests, security reviewer)…"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleInvite() } }}
            />
            <Btn kind="primary" onClick={() => void handleInvite()}>+ Add Agent</Btn>
          </div>
          {participants.length > 0 ? (
            <div className="invite-roster" data-testid="participant-roster">
              {participants.map((p, idx) => (
                <span key={p.id} className="participant-chip" data-testid="participant-chip" data-agent-id={p.agentId}>
                  <StatusDot presence={p.status} />
                  <b>{p.displayName}</b>
                  <code className="agent-id-badge">{p.agentId}</code>
                  {p.role ? <span className="participant-role">· {p.role}</span> : null}
                  {idx > 0 ? (
                    <button
                      className="chip-rm"
                      aria-label={`Remove ${p.displayName}`}
                      title={`Remove ${p.displayName} (${p.agentId})`}
                      onClick={() => void window.asi.chat.removeParticipant(chatId, p.id)}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
              {participants.length > 1 ? (
                <span className="target-picker">
                  <label>Send to:</label>{' '}
                  <select
                    className="field"
                    aria-label="Send target"
                    value={targetParticipantId}
                    onChange={(e) => setTargetParticipantId(e.target.value)}
                  >
                    <option value="">All agents ({participants.length})</option>
                    {participants.map((p) => (
                      <option key={p.id} value={p.id}>{p.displayName} (@{p.agentId})</option>
                    ))}
                  </select>
                </span>
              ) : null}
            </div>
          ) : null}
          {showBoardLog ? (
            <div className="board-log-box" data-testid="board-log-box">
              <div className="board-log-bar">
                <span className="board-path" title={boardPath ?? ''}>📄 {boardPath ?? `.boards/${chatId}.log`}</span>
                <input
                  className="field"
                  style={{ width: 220, minHeight: 20, padding: '1px 6px' }}
                  aria-label="Grep board"
                  placeholder="grep filter (e.g. AGENT=claude-1)…"
                  value={boardGrep}
                  onChange={(e) => setBoardGrep(e.target.value)}
                />
              </div>
              <pre className="board-log-pre" data-testid="board-log-pre">
                {[
                  `# GOAL: ${chat.goal?.trim() || '(none)'}`,
                  ...participants.map((p) => `# AGENT_ROSTER: agent_id=${p.agentId} | name="${p.displayName}" | role="${p.role ?? 'general'}"`),
                  '# [LOG]',
                  ...(filteredBoardEntries.length > 0 ? filteredBoardEntries.map((e) => formatBoardEntry(e)) : ['# (no matching board entries yet)'])
                ].join('\n')}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {deleting ? (
        <div className="mode-note" role="alert" data-testid="delete-confirm">
          <span className="grow">
            Delete this chat and its history?
            {deleting.isolated ? (deleting.dirty > 0
              ? ` Its worktree has ${deleting.dirty} uncommitted change${deleting.dirty === 1 ? '' : 's'}, so the folder will be kept.`
              : ` Its worktree (${deleting.branch}) is removed if clean; the branch is kept if it has unmerged commits.`) : ''}
          </span>
          <Btn kind="danger" onClick={() => void window.asi.chat.delete(chatId)}>Delete</Btn>
          <Btn onClick={() => setDeleting(null)}>Cancel</Btn>
        </div>
      ) : null}
      {editingLabels ? <LabelEditor target={{ kind: 'chat', id: chatId }} onClose={() => setEditingLabels(false)} /> : null}
      <div className={`convo${dropping ? ' dropping' : ''}`} {...dropProps}>
        <div className="transcript" data-testid="transcript">
          {blocks.length === 0 && <div className="empty">Say something to {friend.displayName}.</div>}
          {blocks.map((b, i) => (
            <div key={i} className="block" data-role={b.role}>
              <div className="says"><b>{b.speaker}</b> says:</div>
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
      {friend.harness === 'agy' && chat.mode === 'ask' ? (
        <div className="mode-note">Antigravity applies its CLI permission rules. Workspace files and permitted commands may run without asking.</div>
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
      {pending.length || attachNote ? (
        <div className="tray" data-testid="tray" {...dropProps}>
          {pending.map((p) => (
            <span key={p.id} className="chip-file" data-testid="pending-file">
              {p.preview ? <img src={p.preview} alt="" /> : <span className="ic">{fileBadge(p.name)}</span>}
              <span className="nm">{p.name}{p.size !== undefined && !p.preview ? <span className="sz"> · {fmtBytes(p.size)}</span> : null}</span>
              <button aria-label={`Remove ${p.name}`} onClick={() => setPending((l) => l.filter((x) => x.id !== p.id))}>×</button>
            </span>
          ))}
          {attachNote ? <span className="tray-note" role="status">{attachNote}</span> : null}
        </div>
      ) : null}
      {queued ? (
        <div className="queued" data-testid="queued" data-held={queued.held}>
          <span className="q-badge">Queued</span>
          <span className="q-text" title={queued.text}>{queued.text}</span>
          <span className="q-note">{queued.held ? 'The agent stopped, so this was not sent.' : 'Sends when the agent finishes.'}</span>
          <Btn onClick={() => void window.asi.chat.sendQueuedNow(chatId)} title={queued.held ? 'Send it now' : 'Stop the agent and send it now'}>Send now</Btn>
          <Btn onClick={() => void window.asi.chat.takeQueued(chatId).then((t) => { if (t) setDraft((d) => (d.trim() ? `${t}\n\n${d}` : t)) })}>Edit</Btn>
          <button className="linkish" aria-label="Remove queued prompt" title="Remove queued prompt" onClick={() => void window.asi.chat.takeQueued(chatId)}>✕</button>
        </div>
      ) : null}
      <div className={`composer${dropping ? ' dropping' : ''}`} {...dropProps}>
        <textarea
          ref={composerRef}
          className="field"
          aria-label="Message"
          placeholder={`Reply to ${friend.displayName}… (drop or paste a picture, ! runs a shell command, /open opens a URL or file, /reset starts fresh)`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
            if (files.length) { e.preventDefault(); void addFiles(files) }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape' && (presence === 'busy' || presence === 'away') && !draft.trim()) {
              e.preventDefault()
              void window.asi.chat.interrupt(chatId)
            } else if (e.key === 'ArrowUp' && !draft) {
              const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.kind === 'text' && m.text)
              if (lastUser?.text) {
                e.preventDefault()
                setDraft(lastUser.text)
              }
            }
          }}
          autoFocus
        />
        {presence === 'busy' || presence === 'away' || autoQueue ? (
          <button className={`btn queue-toggle${autoQueue ? ' on' : ''}`} aria-pressed={autoQueue} onClick={() => setAutoQueue((v) => !v)} title="While on, Enter holds your message until the agent finishes (⌘⇧J). You can also type /queue …">⏳ Queue next</button>
        ) : null}
        <button className="btn primary" onClick={send} disabled={!draft.trim() && pending.length === 0}>Send</button>
      </div>
    </Frame>
  )
}

/** The chat body without its own title bar, for use inside a tab. */
function EmbeddedFrame(props: { title: string; danger?: boolean; children: React.ReactNode }) {
  return <div className="win-body embedded" data-danger={props.danger || undefined}>{props.children}</div>
}
