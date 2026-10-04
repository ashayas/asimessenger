import { Avatar, Banner, Btn, StatusDot, ToolButton, WindowFrame } from './ui/kit'
import type { Presence } from '@shared/status'

const PRESENCES: Presence[] = ['online', 'busy', 'away', 'offline']

export function Gallery() {
  return (
    <WindowFrame title="ASI Messenger: UI kit">
      <Banner
        avatar={<Avatar label="A" gradient={['#e05297', '#f39ac2']} presence="online" size="lg" />}
        name={<>Ashaya <span style={{ fontWeight: 'normal' }}>(Online) ▾</span></>}
        message="<shipping asi messenger>"
      />
      <div className="toolbar" data-testid="toolbar">
        <ToolButton icon="👥" label="Invite" />
        <ToolButton icon="📎" label="Send Files" />
        <ToolButton icon="✏️" label="Doodle" />
        <ToolButton icon="📳" label="Nudge" />
        <ToolButton icon="⏹" label="Stop" stop />
      </div>
      <div className="gallery" data-testid="gallery">
        <section>
          <h2>Presence</h2>
          <div className="row">
            {PRESENCES.map((p) => (
              <span className="chip" key={p}><StatusDot presence={p} />{p}</span>
            ))}
          </div>
        </section>
        <section>
          <h2>Display pictures</h2>
          <div className="row">
            <Avatar label="C" gradient={['#d97757', '#b85a3c']} presence="busy" working />
            <Avatar label="Cx" gradient={['#2b2b2b', '#5a5a5a']} presence="away" waiting />
            <Avatar label="G" gradient={['#4285f4', '#9b72cb']} presence="online" />
            <Avatar label="π" gradient={['#7b8794', '#a9b3be']} presence="offline" />
            <Avatar label="✦" gradient={['#1a43b8', '#4f9ee8']} presence="online" size="xl" />
          </div>
        </section>
        <section>
          <h2>Buttons and fields</h2>
          <div className="row">
            <Btn kind="primary">Allow once</Btn>
            <Btn>Allow for this chat</Btn>
            <Btn kind="danger">Deny…</Btn>
            <Btn disabled>Disabled</Btn>
            <input className="field" style={{ maxWidth: 220 }} defaultValue="Find a friend…" />
            <span className="badge">3</span>
            <span className="funky">✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧</span>
          </div>
        </section>
      </div>
    </WindowFrame>
  )
}
