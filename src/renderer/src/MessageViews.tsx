import { useEffect, useState } from 'react'
import type { Message } from '@shared/models'
import type { AgentEvent } from '@shared/events'
import { Btn } from './ui/kit'
import { badgeFor } from '@shared/attachments'
import { findLocalUrls } from '@shared/browser'

type Tool = Extract<AgentEvent, { t: 'tool' }>
type Perm = Extract<AgentEvent, { t: 'permission' }> & { decision: string | null; reason?: string | null }
type Quest = Extract<AgentEvent, { t: 'question' }> & { answer: string | null }
type Attach = Extract<AgentEvent, { t: 'attachment' }>

const DECISION_LABEL: Record<string, string> = { 'allow-once': 'Allowed once', 'allow-chat': 'Allowed for this chat', deny: 'Denied' }

export function MessageView({ m, chatId }: { m: Message; chatId: string }) {
  switch (m.kind) {
    case 'text': {
      const quote = (m.body as { quote?: { name: string; text: string } } | null)?.quote
      return (
        <div className="msg" data-kind="text">
          {quote ? <blockquote className="quote" data-testid="quote"><div className="qname">{quote.name}</div>{quote.text}</blockquote> : null}
          {m.text}
          {m.role === 'agent' ? <LocalLinks text={m.text ?? ''} /> : null}
        </div>
      )
    }
    case 'thinking':
      return (
        <details className="msg thinking" data-kind="thinking">
          <summary>Thinking…</summary>
          {m.text}
        </details>
      )
    case 'tool':
      return <ToolBlock tool={m.body as Tool} />
    case 'permission':
      return <PermissionCard chatId={chatId} p={m.body as Perm} />
    case 'question':
      return <QuestionCard chatId={chatId} q={m.body as Quest} />
    case 'attachment':
      return <AttachmentCard a={m.body as Attach} messageId={m.id} />
    case 'links':
      return <LinksCard items={(m.body as { items: LinkItem[] }).items} />
    case 'open_url': {
      const url = String((m.body as { url?: string } | null)?.url ?? m.text ?? '')
      return (
        <div className="card link" data-kind="open_url">
          <span aria-hidden="true">🌐</span><span className="url" title={url}>{url}</span>
          <Btn onClick={() => void window.asi.browser.open(url)}>Open</Btn>
        </div>
      )
    }
    case 'nudge':
      return <div className="msg nudge" data-kind="nudge">📳 {m.text}</div>
    case 'error':
      return <div className="msg err" data-kind="error">⚠ {m.text}</div>
    default:
      return <div className="msg faint" data-kind={m.kind}>{m.text}</div>
  }
}

function ToolBlock({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false)
  const running = tool.done === false
  return (
    <div className="blk" data-kind="tool" data-running={running || undefined}>
      <button className="h" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cmd">{tool.command ? `$ ${tool.command}` : tool.title}</span>
        <span className={tool.exit ? 'x bad' : 'x'}>
          {running ? 'running…' : tool.exit != null ? `exit ${tool.exit}` : 'done'}
          {tool.durationMs != null ? ` · ${(tool.durationMs / 1000).toFixed(1)}s` : ''} {open ? '▾' : '▸'}
        </span>
      </button>
      {tool.files?.map((f) => (
        <div className="o" key={f.path}>{f.path} <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></div>
      ))}
      {open && tool.output ? <pre className="o">{tool.output}</pre> : null}
    </div>
  )
}

function PermissionCard({ chatId, p }: { chatId: string; p: Perm }) {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const answer = (id: string, why?: string) => void window.asi.chat.respond(chatId, p.reqId, id, why)
  return (
    <div className="card perm" data-kind="permission" data-decision={p.decision ?? 'pending'} data-risk={p.risk}>
      <div className="row">
        <b>Wants to run: {p.tool}</b>
        {p.risk ? <span className={`risk ${p.risk}`}>{p.risk} risk</span> : null}
      </div>
      <div className="mono">{p.summary}</div>
      {p.decision ? (
        <div className="decided">{DECISION_LABEL[p.decision] ?? p.decision}{p.reason ? ` — ${p.reason}` : ''}</div>
      ) : denying ? (
        <div className="deny-reason">
          <input className="field" aria-label="Reason for denying" autoFocus placeholder="Tell the agent why (optional)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') answer('deny', reason.trim() || undefined) }} />
          <Btn kind="danger" onClick={() => answer('deny', reason.trim() || undefined)}>Deny</Btn>
          <Btn onClick={() => setDenying(false)}>Back</Btn>
        </div>
      ) : (
        <div className="row">
          {p.options.map((o) =>
            o.id === 'deny' ? (
              <Btn key={o.id} kind="danger" onClick={() => setDenying(true)}>Deny…</Btn>
            ) : (
              <Btn key={o.id} kind={o.id === 'allow-once' ? 'primary' : undefined} onClick={() => answer(o.id)}>{o.label}</Btn>
            )
          )}
        </div>
      )}
    </div>
  )
}

function QuestionCard({ chatId, q }: { chatId: string; q: Quest }) {
  const [text, setText] = useState('')
  const answer = (a: string) => void window.asi.chat.respond(chatId, q.reqId, a)
  return (
    <div className="card q" data-kind="question" data-answered={q.answer != null || undefined}>
      <div><b>Asks:</b> {q.prompt}</div>
      {q.answer != null ? (
        <div className="decided">You answered: {q.answer}</div>
      ) : (
        <>
          <div className="row">{q.choices?.map((c) => <Btn key={c} onClick={() => answer(c)}>{c}</Btn>)}</div>
          <div className="row">
            <input className="field" aria-label="Type an answer" placeholder="Type an answer…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) answer(text.trim()) }} />
            <Btn disabled={!text.trim()} onClick={() => answer(text.trim())}>Answer</Btn>
          </div>
        </>
      )}
    </div>
  )
}

function AttachmentCard({ a, messageId }: { a: Attach; messageId: string }) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    if (a.kind !== 'image') return
    let live = true
    void window.asi.attachments.load(messageId).then((l) => { if (live) setThumb(l.text) }).catch(() => {})
    return () => { live = false }
  }, [a.kind, messageId])
  return (
    <div className="card" data-kind="attachment">
      {thumb ? <img className="thumb" src={thumb} alt={a.name} data-testid="thumb" onClick={() => void window.asi.attachments.open(messageId)} /> : null}
      <div className="file">
        <div className="ic">{badgeFor(a.kind)}</div>
        <div className="grow"><b>{a.name}</b><div className="says">{a.kind} · sent as attachment</div></div>
        <Btn onClick={() => void window.asi.attachments.open(messageId)}>Open</Btn>
      </div>
    </div>
  )
}

/** Dev-server links the agent mentioned become one-click "open in the browser" chips. */
function LocalLinks({ text }: { text: string }) {
  const urls = findLocalUrls(text)
  if (urls.length === 0) return null
  return (
    <div className="chips" data-testid="local-links">
      {urls.map((u) => <Btn key={u} onClick={() => void window.asi.browser.open(u)} title="Open in the ASI Messenger browser">🌐 Open {u}</Btn>)}
    </div>
  )
}

type LinkItem = { label: string; detail?: string; target: import('@shared/search').SearchTarget }

/** ASI's answers: each row jumps to the chat/attachment/drawing, or brings an outside session in. */
function LinksCard({ items }: { items: LinkItem[] }) {
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="card links" data-kind="links">
      {items.map((it, i) => (
        <div className="link-row" key={i} data-target={it.target.type}>
          <div className="grow"><b>{it.label}</b>{it.detail ? <div className="says">{it.detail}</div> : null}</div>
          <Btn onClick={() => { setErr(null); window.asi.search.jump(it.target).catch((e: unknown) => setErr(String(e).replace(/^Error invoking remote method '[^']+': Error: /, ''))) }}>{it.target.type === 'adopt' ? 'Bring in' : 'Open'}</Btn>
        </div>
      ))}
      {err ? <div className="note bad" role="alert">{err}</div> : null}
    </div>
  )
}
