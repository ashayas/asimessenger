import { useEffect, useState } from 'react'
import { avatarFor } from '@shared/harness-meta'
import type { Chat, Friend } from '@shared/models'
import { Avatar, Btn } from './ui/kit'
import { play } from './sounds'

/** The Messenger-style popup in the corner of the screen. */
export function Toast() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const chatId = q.get('chat') ?? ''
  const kind = q.get('kind') ?? 'message'
  const text = q.get('text') ?? ''
  const risk = q.get('risk') ?? ''
  const req = q.get('req') ?? ''
  const [friend, setFriend] = useState<Friend | null>(null)
  const [chat, setChat] = useState<Chat | null>(null)

  useEffect(() => {
    void (async () => {
      const c = await window.asi.api.chats.get(chatId)
      setChat(c)
      if (c) setFriend(await window.asi.api.friends.get(c.friendId))
    })()
    play('message')
  }, [chatId])

  if (!friend) return <div className="toast" />
  const a = avatarFor(friend)
  const verb = kind === 'permission' ? 'needs your OK' : kind === 'question' ? 'has a question' : kind === 'error' ? 'hit a problem' : 'says'
  return (
    <div className="toast" data-kind={kind} data-testid="toast">
      <div className="toast-title"><span>ASI Messenger</span><button aria-label="Dismiss" onClick={() => void window.asi.chat.toastDismiss()}>×</button></div>
      <div className="toast-body">
        <Avatar label={a.label} gradient={a.gradient} presence={kind === 'message' ? 'online' : 'away'} size="sm" waiting={kind !== 'message'} />
        <div className="toast-text">
          <b>{friend.displayName}</b> {verb}{kind === 'message' ? ':' : ''}
          <div className="snip">{text}</div>
        </div>
      </div>
      <div className="toast-actions">
        {kind === 'permission' && risk !== 'high' ? <Btn kind="primary" onClick={() => { void window.asi.chat.respond(chatId, req, 'allow-once'); void window.asi.chat.toastDismiss() }}>Allow</Btn> : null}
        <Btn onClick={() => void window.asi.chat.toastOpenChat(chat?.id ?? chatId)}>Open chat</Btn>
      </div>
    </div>
  )
}
