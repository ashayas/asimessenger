import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { Presence } from '@shared/status'

export function WindowFrame(props: { title: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className="win">
      <div className={`titlebar${props.danger ? ' danger' : ''}`}>
        <span className="t">{props.title}</span>
      </div>
      <div className="win-body">{props.children}</div>
    </div>
  )
}

export function StatusDot({ presence }: { presence: Presence }) {
  return <span className={`dot ${presence}`} data-presence={presence} />
}

export interface AvatarProps {
  label: string
  gradient: [string, string]
  presence: Presence
  size?: 'sm' | 'md' | 'lg' | 'xl'
  working?: boolean
  waiting?: boolean
}

/** Display picture: harness colour + presence-coloured frame; dashed ring while working, pulse while waiting on you. */
export function Avatar({ label, gradient, presence, size = 'md', working, waiting }: AvatarProps) {
  const cls = ['dp', presence, size === 'md' ? '' : size, working ? 'working' : '', waiting ? 'waiting' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div
      className={cls}
      data-presence={presence}
      style={{ background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }}
      aria-hidden="true"
    >
      {label}
    </div>
  )
}

export function Btn(props: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'danger' }) {
  const { kind, className, ...rest } = props
  return <button {...rest} className={['btn', kind ?? '', className ?? ''].join(' ').trim()} />
}

export function ToolButton(props: {
  icon: string
  label: string
  onClick?: () => void
  disabled?: boolean
  stop?: boolean
}) {
  return (
    <button className={`tool${props.stop ? ' stop' : ''}`} onClick={props.onClick} disabled={props.disabled}>
      <span className="ic" aria-hidden="true">{props.icon}</span>
      {props.label}
    </button>
  )
}

export function Banner(props: { avatar: ReactNode; name: ReactNode; message?: ReactNode }) {
  return (
    <div className="banner">
      {props.avatar}
      <div className="who">
        <div className="name">{props.name}</div>
        {props.message ? <div className="pm">{props.message}</div> : null}
      </div>
    </div>
  )
}
