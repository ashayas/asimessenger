import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Btn, WindowFrame } from './ui/kit'

type Loaded = Awaited<ReturnType<typeof window.asi.attachments.load>>

export function AttachmentViewer({ messageId }: { messageId: string }) {
  const [a, setA] = useState<Loaded | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [selection, setSelection] = useState('')
  const [reply, setReply] = useState('')
  const [sent, setSent] = useState(false)

  useEffect(() => {
    window.asi.attachments.load(messageId).then(setA, (e: unknown) => setErr(String(e).replace(/^Error invoking remote method '[^']+': Error: /, '')))
  }, [messageId])

  useEffect(() => {
    if (a) document.title = a.name
    const onSel = () => setSelection(String(document.getSelection() ?? '').trim())
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [a])

  const html = useMemo(() => (a?.kind === 'markdown' || a?.kind === 'plan' ? DOMPurify.sanitize(marked.parse(a.text, { async: false }) as string) : ''), [a])
  const quoteText = selection || (a?.text ?? '').slice(0, 4000)

  if (err) return <WindowFrame title="Attachment"><div className="empty">{err}</div></WindowFrame>
  if (!a) return <WindowFrame title="Attachment"><div className="empty">Loading…</div></WindowFrame>

  const send = async () => {
    if (!reply.trim()) return
    await window.asi.chat.send(a.chatId, reply.trim(), { name: a.name, text: quoteText })
    await window.asi.chat.openWindow(a.chatId)
    setReply('')
    setSent(true)
  }

  const lines = a.text.split('\n')
  return (
    <WindowFrame title={`${a.name} · from ${a.friendName}`}>
      <div className="viewer" data-testid="viewer" data-kind={a.kind}>
        {a.kind === 'image' ? (
          <div className="imgview"><img src={a.text} alt={a.name} /></div>
        ) : html ? (
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="codeview">
            {lines.map((l, i) => (
              <div key={i} className={`ln${a.kind === 'diff' ? (l.startsWith('+') ? ' add' : l.startsWith('-') ? ' del' : l.startsWith('@@') ? ' hunk' : '') : ''}`}>
                <span className="no">{i + 1}</span>
                <span className="src">{l || ' '}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="replybar">
        <div className="quoting" data-testid="quoting">
          {selection ? <>Replying to your selection ({selection.split('\n').length} line{selection.includes('\n') ? 's' : ''})</> : <>Replying to the whole file. Select text to quote just part of it.</>}
          {sent ? <span className="sent"> ✔ Sent to {a.friendName}</span> : null}
        </div>
        <div className="composer-lite">
          <textarea className="field" aria-label="Reply" placeholder={`Reply to ${a.friendName} about ${a.name}…`} value={reply} onChange={(e) => { setReply(e.target.value); setSent(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }} />
          <Btn kind="primary" disabled={!reply.trim()} onClick={() => void send()}>Send reply</Btn>
        </div>
      </div>
    </WindowFrame>
  )
}
