import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { Btn, ToolButton, WindowFrame } from './ui/kit'

interface SceneApi {
  getSceneElements(): readonly unknown[]
  getAppState(): Record<string, unknown>
  getFiles(): Record<string, unknown>
}
type Initial = { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown>; scrollToContent?: boolean } | null

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

/** Excalidraw window: drawings autosave to <workspace>/.drawings and can be sent to a chat as an image. */
export default function Doodle({ workspaceId, chatId: initialChat, name: initialName }: { workspaceId: string; chatId: string | null; name: string | null }) {
  const [name, setName] = useState<string | null>(initialName)
  const [chatId, setChatId] = useState<string | null>(initialChat)
  const [names, setNames] = useState<string[]>([])
  const [initial, setInitial] = useState<Initial | undefined>(undefined)
  const [saved, setSaved] = useState<string>('')
  const [sentNote, setSentNote] = useState('')
  const api = useRef<SceneApi | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Signature (id:version) of the scene last saved/loaded; onChange fires for non-edits too (selection, scroll). */
  const lastSig = useRef('')

  const refreshList = useCallback(async () => setNames((await window.asi.doodle.list(workspaceId)).map((d) => d.name)), [workspaceId])

  // pick the drawing: requested, else most recent, else a new one
  useEffect(() => {
    void (async () => {
      await refreshList()
      if (name) return
      const list = await window.asi.doodle.list(workspaceId)
      setName(list[0]?.name ?? (await window.asi.doodle.newName(workspaceId)))
    })()
  }, [workspaceId, name, refreshList])

  useEffect(() => window.asi.doodle.onOpen((a) => { if (a.chatId) setChatId(a.chatId); if (a.name) setName(a.name) }), [])

  useEffect(() => {
    if (!name) return
    lastSig.current = ''
    setInitial(undefined)
    document.title = `Doodle · ${name}`
    void window.asi.doodle.load(workspaceId, name).then((json) => {
      if (!json) return setInitial(null)
      const d = JSON.parse(json) as { elements?: { id: string; version: number }[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }
      lastSig.current = (d.elements ?? []).map((e) => `${e.id}:${e.version}`).join(',')
      setInitial({ elements: d.elements, appState: { ...d.appState, collaborators: new Map() }, files: d.files, scrollToContent: true })
    })
  }, [workspaceId, name])

  const flush = useCallback(async () => {
    if (!name || !api.current) return
    const json = serializeAsJSON(api.current.getSceneElements() as never, api.current.getAppState() as never, api.current.getFiles() as never, 'local')
    await window.asi.doodle.save(workspaceId, name, json)
    setSaved(`Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
    void refreshList()
  }, [workspaceId, name, refreshList])

  const onChange = useCallback((elements: readonly { id: string; version: number }[]) => {
    const sig = elements.map((e) => `${e.id}:${e.version}`).join(',')
    if (sig === lastSig.current) return
    lastSig.current = sig
    setSaved('Saving…')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 700)
  }, [flush])

  const send = async () => {
    if (!name || !chatId || !api.current) return
    await flush()
    const blob = await exportToBlob({ elements: api.current.getSceneElements() as never, appState: { ...api.current.getAppState(), exportBackground: true } as never, files: api.current.getFiles() as never, mimeType: 'image/png', exportPadding: 16 })
    await window.asi.doodle.send(workspaceId, chatId, name, await toBase64(blob))
    setSentNote('Sent to the chat')
    setTimeout(() => setSentNote(''), 3000)
  }

  const create = async () => {
    await flush()
    setName(await window.asi.doodle.newName(workspaceId))
  }

  return (
    <WindowFrame title={`Doodle · ${name ?? ''}`}>
      <div className="toolbar doodle-bar">
        <ToolButton icon="🆕" label="New" onClick={() => void create()} />
        <label className="pick">
          <span>Drawing</span>
          <select aria-label="Drawing" value={name ?? ''} onChange={(e) => void flush().then(() => setName(e.target.value))}>
            {name && !names.includes(name) ? <option value={name}>{name} (new)</option> : null}
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <ToolButton icon="📤" label="Send to chat" disabled={!chatId} onClick={() => void send()} />
        <ToolButton icon="📂" label="Reveal" onClick={() => void window.asi.doodle.reveal(workspaceId)} />
        <span className="grow" />
        <span className="saved" data-testid="doodle-status">{sentNote || saved}</span>
        <Btn onClick={() => void flush()}>Save</Btn>
      </div>
      <div className="doodle-canvas" data-testid="doodle-canvas">
        {initial !== undefined && name ? (
          <Excalidraw key={name} initialData={(initial ?? { appState: {} }) as never} excalidrawAPI={(a) => { api.current = a as unknown as SceneApi }} onChange={onChange as never} />
        ) : null}
      </div>
    </WindowFrame>
  )
}
